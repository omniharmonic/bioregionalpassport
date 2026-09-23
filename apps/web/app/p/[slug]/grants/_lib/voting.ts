/**
 * Client-side voting helpers for grants rounds (PRD F6, FR-GR-2/3).
 *
 * - Quadratic cost meter: a ballot spends Σ votes² voice credits, at most the round's voice budget.
 * - Ballot construction: `{ round, voterKey, issuer: voterKey, allocations, createdAt, nonce }` signed with a
 *   per-round pseudonymous did:key (`deriveRoundKey(personaSeed, roundId)`), proofPurpose assertionMethod —
 *   exactly what `services/round` `submitBallot` accepts.
 * - Group votes: the ballot is signed with a per-round key derived for that group, and carries
 *   `linkage.presentation`: membership pair + the group's delegation and the holder's acceptance + the pod's
 *   authority credential for the group, and NOT the holder's own `round:vote` authority credential (the
 *   verifier would then treat the ballot as the holder's own and refuse it as not a group vote).
 * - Seed and stored credentials are read straight from the passport's IndexedDB (`passport-wallet`, schema of
 *   `packages/pod-client` `WalletDb`), through the narrow `getPersonaSeed` / `getPodCredentials` interface, until
 *   `packages/pod-client` exposes them.
 */
import {
  createPresentation,
  deriveRoundKey,
  fromBase64url,
  keyPairFromSeed,
  randomNonce,
  signDocument,
  type DataIntegrityProof,
  type KeyPair,
  type VerifiableCredential,
  type VerifiablePresentation,
} from '@passport/credential-core';

/** Most votes one ballot may give a single proposal in the stepper. */
export const MAX_VOTES_PER_PROPOSAL = 10;

export type Allocations = Record<string, number>;

export interface UnsignedBallot {
  round: string;
  voterKey: string;
  issuer: string;
  allocations: Allocations;
  createdAt: string;
  nonce: string;
}

export type SignedBallot = UnsignedBallot & { proof: DataIntegrityProof };

export interface BallotBody {
  ballot: SignedBallot;
  linkage?: { presentation: VerifiablePresentation };
}

// ── cost meter ───────────────────────────────────────────────────────────────────────────────────────

/** Voice credits a set of allocations spends: Σ votes². */
export function voiceCost(allocations: Allocations): number {
  let cost = 0;
  for (const v of Object.values(allocations)) cost += v * v;
  return cost;
}

export interface Meter {
  cost: number;
  budget: number;
  remaining: number;
  over: boolean;
  /** Share of the budget spent, 0–1 (capped at 1). */
  fraction: number;
}

export function meter(allocations: Allocations, budget: number): Meter {
  const cost = voiceCost(allocations);
  return {
    cost,
    budget,
    remaining: budget - cost,
    over: cost > budget,
    fraction: budget > 0 ? Math.min(1, cost / budget) : 1,
  };
}

/** Clamps a stepper value to a whole number in [0, max]. */
export function clampVotes(v: number, max = MAX_VOTES_PER_PROPOSAL): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(max, Math.trunc(v)));
}

/** Whole, positive votes only (zero entries are dropped so the ballot stays small). */
export function cleanAllocations(allocations: Allocations): Allocations {
  const out: Allocations = {};
  for (const [id, v] of Object.entries(allocations)) {
    const n = clampVotes(v, Number.MAX_SAFE_INTEGER);
    if (n > 0) out[id] = n;
  }
  return out;
}

/** Can one more vote go to a proposal without exceeding the budget or the stepper maximum? */
export function canAddVote(allocations: Allocations, proposalId: string, budget: number): boolean {
  const current = allocations[proposalId] ?? 0;
  if (current >= MAX_VOTES_PER_PROPOSAL) return false;
  return voiceCost({ ...allocations, [proposalId]: current + 1 }) <= budget;
}

// ── keys and ballots ─────────────────────────────────────────────────────────────────────────────────

/**
 * The per-round voting key. Personal: `deriveRoundKey(seed, roundId)`. For a group the round id is suffixed
 * with the group identifier, so the member's own key and the group's key are never the same (the service
 * refuses one key voting for two different voters in a round).
 */
export function roundKeyFor(personaSeed: Uint8Array, roundId: string, group?: string): KeyPair {
  return deriveRoundKey(personaSeed, group ? `${roundId}#group:${group}` : roundId);
}

/** Builds and signs a ballot with the given per-round key. */
export function buildBallot(key: KeyPair, roundId: string, allocations: Allocations, now: Date = new Date()): SignedBallot {
  const createdAt = now.toISOString();
  const unsigned: UnsignedBallot = {
    round: roundId,
    voterKey: key.did,
    issuer: key.did,
    allocations: cleanAllocations(allocations),
    createdAt,
    nonce: randomNonce(16),
  };
  return signDocument(unsigned, key, { proofPurpose: 'assertionMethod', created: createdAt });
}

// ── group votes ──────────────────────────────────────────────────────────────────────────────────────

const typesOf = (vc: VerifiableCredential): string[] => (Array.isArray(vc.type) ? vc.type : [String(vc.type)]);
const hasType = (vc: VerifiableCredential, t: string): boolean => typesOf(vc).includes(t);
const issuerOf = (vc: VerifiableCredential): string =>
  typeof vc.issuer === 'string' ? vc.issuer : String((vc.issuer as unknown as { id?: string })?.id ?? '');

export interface GroupOption {
  /** Group identifier (the delegation's issuer). */
  did: string;
  label: string;
}

/**
 * Groups that delegated `round:vote` to this holder: DelegationCredential grants issued by the group to the
 * holder whose scope covers `round:vote`.
 */
export function groupsFor(credentials: VerifiableCredential[], holder: string): GroupOption[] {
  const seen = new Map<string, GroupOption>();
  for (const vc of credentials) {
    if (!hasType(vc, 'DelegationCredential')) continue;
    const subject = vc.credentialSubject ?? {};
    const scope: unknown = subject['delegation']?.['scope'];
    const issuer = issuerOf(vc);
    if (subject.id !== holder || issuer === holder || !Array.isArray(scope) || !scope.includes('round:vote')) continue;
    if (subject['delegation']?.['accepts'] !== undefined) continue; // an acceptance, not a grant
    const name = typeof subject['groupName'] === 'string' ? subject['groupName'] : typeof subject['name'] === 'string' ? subject['name'] : null;
    if (!seen.has(issuer)) seen.set(issuer, { did: issuer, label: name ?? `Group ${abbreviate(issuer)}` });
  }
  return [...seen.values()];
}

/**
 * The credentials a group vote presents: the holder's membership pair, the group's delegation to the holder and
 * the holder's acceptance, and the pod's authority credential for the group. The holder's own authority
 * credentials are left out on purpose (see file header).
 */
export function groupVoteCredentials(credentials: VerifiableCredential[], holder: string, group: string): VerifiableCredential[] {
  return credentials.filter((vc) => {
    const subject = vc.credentialSubject?.id;
    const issuer = issuerOf(vc);
    if (hasType(vc, 'MembershipCredential')) return subject === holder || issuer === holder;
    if (hasType(vc, 'DelegationCredential')) return (issuer === group && subject === holder) || (issuer === holder && subject === group);
    if (hasType(vc, 'AuthorityCredential')) return subject === group;
    return false;
  });
}

/** The group presentation: signed by the holder, challenge = round id, domain = the pod's host. */
export function groupPresentation(
  credentials: VerifiableCredential[],
  holderKey: KeyPair,
  group: string,
  opts: { roundId: string; domain: string },
): VerifiablePresentation {
  const creds = groupVoteCredentials(credentials, holderKey.did, group);
  return createPresentation(creds, holderKey, { challenge: opts.roundId, domain: opts.domain });
}

/** Full ballot body for `POST /api/round/rounds/:id/ballots`. */
export function ballotBody(
  personaSeed: Uint8Array,
  roundId: string,
  allocations: Allocations,
  opts: { group?: string; credentials?: VerifiableCredential[]; domain?: string; now?: Date } = {},
): BallotBody {
  const key = roundKeyFor(personaSeed, roundId, opts.group);
  const ballot = buildBallot(key, roundId, allocations, opts.now);
  if (!opts.group) return { ballot };
  if (!opts.domain) throw new Error('A group vote needs the pod domain.');
  const presentation = groupPresentation(opts.credentials ?? [], keyPairFromSeed(personaSeed), opts.group, { roundId, domain: opts.domain });
  return { ballot, linkage: { presentation } };
}

// ── display ──────────────────────────────────────────────────────────────────────────────────────────

/** `did:key:z6MkABCD…wxyz` style abbreviation for identifiers. */
export function abbreviate(id: string | null | undefined, head = 6, tail = 4): string {
  if (!id) return '';
  const prefix = id.startsWith('did:key:') ? 'did:key:' : id.startsWith('did:web:') ? 'did:web:' : '';
  const rest = id.slice(prefix.length);
  if (rest.length <= head + tail + 1) return id;
  return `${prefix}${rest.slice(0, head)}…${rest.slice(-tail)}`;
}

// ── passport storage (IndexedDB) ─────────────────────────────────────────────────────────────────────

export const WALLET_DB = 'passport-wallet';

/** Decodes a stored 32-byte seed: bytes, byte array, hex or base64url. */
export function decodeSeed(raw: unknown): Uint8Array | null {
  let bytes: Uint8Array | null = null;
  if (raw instanceof Uint8Array) bytes = raw;
  else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
  else if (Array.isArray(raw) && raw.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) bytes = Uint8Array.from(raw as number[]);
  else if (typeof raw === 'string') {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) bytes = Uint8Array.from(raw.match(/../g)!.map((h) => parseInt(h, 16)));
    else {
      try {
        bytes = fromBase64url(raw.replace(/=+$/, ''));
      } catch {
        bytes = null;
      }
    }
  }
  return bytes && bytes.length === 32 ? Uint8Array.from(bytes) : null;
}

type Row = Record<string, any>;

/** The persona seed field of a stored identifier (`seed` in `packages/pod-client`; older names accepted). */
export function seedOfIdentifier(row: Row | undefined | null): Uint8Array | null {
  for (const k of ['seed', 'personaSeed', 'privateKey', 'secretKey']) {
    const s = decodeSeed(row?.[k]);
    if (s) return s;
  }
  return null;
}

/**
 * Picks the persona seed for a pod. The passport records the persona it uses with each pod in
 * `pods.personaDid` (it may be an identifier first made for another pod); otherwise the pod's `directed`
 * identifier is the persona. Pairwise identifiers are never used.
 */
export function pickPersona(identifiers: Row[], personaDid?: string | null): Uint8Array | null {
  if (personaDid) {
    const named = identifiers.find((r) => r['did'] === personaDid);
    const seed = seedOfIdentifier(named);
    if (seed) return seed;
  }
  const isPersona = (r: Row) => r['scope'] === 'directed' || [r['kind'], r['type'], r['role']].includes('persona');
  for (const r of identifiers.filter(isPersona)) {
    const seed = seedOfIdentifier(r);
    if (seed) return seed;
  }
  return null;
}

/** A stored credential row → the credential (`raw` in `packages/pod-client`; `credential`/`vc`/bare accepted). */
export function credentialOfRow(row: Row): VerifiableCredential | null {
  if (row?.['status'] === 'superseded') return null;
  for (const c of [row?.['raw'], row?.['credential'], row?.['vc'], row]) {
    if (c && typeof c === 'object' && c['credentialSubject'] && c['proof'] && c['type']) return c as VerifiableCredential;
  }
  return null;
}

async function databaseExists(name: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  const list = (indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }).databases;
  if (typeof list !== 'function') return true; // cannot tell; Dexie opens what is there
  try {
    return (await list.call(indexedDB)).some((d) => d.name === name);
  } catch {
    return true;
  }
}

interface WalletReader {
  /** Rows of `table` whose `pod` is `pod` ([] when the table is missing). */
  byPod(table: string, pod: string): Promise<Row[]>;
  /** One row by primary key, or undefined. */
  get(table: string, key: string): Promise<Row | undefined>;
}

/** Opens the passport's database read-only in spirit (no schema declared, nothing written). */
async function withWallet<T>(fallback: T, fn: (w: WalletReader) => Promise<T>): Promise<T> {
  if (!(await databaseExists(WALLET_DB))) return fallback;
  const { default: Dexie } = await import('dexie');
  // No schema declared: Dexie opens the passport's database as it is (dynamic mode) and never alters it.
  const db = new Dexie(WALLET_DB);
  try {
    await db.open();
    const has = (t: string) => db.tables.some((x) => x.name === t);
    return await fn({
      async byPod(table, pod) {
        if (!has(table)) return [];
        const t = db.table(table);
        try {
          return await t.where('pod').equals(pod).toArray();
        } catch {
          return await t.filter((r: Row) => r['pod'] === pod).toArray(); // `pod` not indexed
        }
      },
      async get(table, key) {
        return has(table) ? db.table(table).get(key) : undefined;
      },
    });
  } catch {
    return fallback;
  } finally {
    db.close();
  }
}

/** The persona seed the passport holds for this pod, or null when it holds none. */
export async function getPersonaSeed(slug: string): Promise<Uint8Array | null> {
  return withWallet<Uint8Array | null>(null, async (w) => {
    const pod = await w.get('pods', slug);
    const personaDid = typeof pod?.['personaDid'] === 'string' ? pod['personaDid'] : null;
    const rows = await w.byPod('identifiers', slug);
    if (personaDid && !rows.some((r) => r['did'] === personaDid)) {
      const reused = await w.get('identifiers', personaDid);
      if (reused) rows.push(reused);
    }
    return pickPersona(rows, personaDid);
  });
}

/** Every current credential the passport stores for this pod. */
export async function getPodCredentials(slug: string): Promise<VerifiableCredential[]> {
  const rows = await withWallet<Row[]>([], (w) => w.byPod('credentials', slug));
  return rows.map(credentialOfRow).filter((c): c is VerifiableCredential => c !== null);
}
