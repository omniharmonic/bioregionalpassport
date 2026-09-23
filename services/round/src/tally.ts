/**
 * Pure quadratic-voting tally (MVP plan §5 Task 13, PRD FR-GR-2). No I/O: the service, the UI and anyone
 * holding the published ballots can run it and get the same numbers.
 *
 * - Cost of a ballot: Σ votes² voice credits (`voiceCost`), at most the round's voice budget.
 * - Contribution of a ballot to a proposal: `weight × sqrt(votes)`, weight by tier (T2 1.0, T3/T4 1.2).
 * - Per proposal: `voiceSum = Σ contributions`, `qf = voiceSum²`, `share = qf / Σ qf`.
 * - Matching: the pool is split by `share` in whole cents; a proposal above `matchingCap` is capped and the
 *   excess is re-split among the rest; the rounding remainder goes to the top proposal (highest `qf`, then id).
 *   Money a cap leaves undistributable is reported as `unallocated`.
 * - Steward adjustments are applied last to `matching` and listed, never silently.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalize, type DataIntegrityProof } from '@passport/credential-core';

/** Tier weights applied as `weight × sqrt(votes)`. A group votes at T2. Unknown tiers weigh 1.0. */
export const ROUND_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({ T2: 1, T3: 1.2, T4: 1.2 });
export const DEFAULT_VOICE_BUDGET = 100;

export type Allocations = Record<string, number>;

/** The ballot a voter signs with the per-round `did:key` (`issuer === voterKey`, proofPurpose assertionMethod). */
export interface SignedBallot {
  round: string;
  voterKey: string;
  issuer: string;
  allocations: Allocations;
  createdAt: string;
  nonce: string;
  proof: DataIntegrityProof;
}

/**
 * A ballot as published with the tally: the signed ballot plus two service annotations that are NOT covered
 * by the voter's signature — `tier` (sets the weight) and, for a group vote, `onBehalfOf` (the group DID the
 * pod verified through a delegation chain). Strip both before checking the proof (`signedPart`).
 */
export interface PublishedBallot extends SignedBallot {
  tier: string;
  onBehalfOf?: string;
}

export interface TallyAdjustment {
  proposalId: string;
  delta: number;
  reason: string;
  stewardDid: string;
  createdAt: string;
}

export interface TallyEntry {
  id: string;
  rawVotes: number;
  voters: number;
  voiceSum: number;
  qf: number;
  share: number;
  /** Final matching after adjustments. */
  matching: number;
  /** Sum of steward adjustments applied to this proposal (0 when none). */
  adjustment: number;
}

export interface Tally {
  proposals: TallyEntry[];
  pool: number;
  matchingCap: number | null;
  weights: Record<string, number>;
  ballotCount: number;
  ballotsHash: string;
  totalMatching: number;
  unallocated: number;
  computedAt: string;
  adjustments: TallyAdjustment[];
}

export interface TallyOptions {
  matchingCap?: number | null;
  adjustments?: TallyAdjustment[];
  computedAt?: string;
}

/** Voice credits a ballot spends: Σ votes². */
export function voiceCost(allocations: Allocations): number {
  let cost = 0;
  for (const v of Object.values(allocations ?? {})) cost += v * v;
  return cost;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The signed portion of a published ballot (drops the `tier` / `onBehalfOf` annotations). */
export function signedPart(b: PublishedBallot): SignedBallot {
  const { tier: _tier, onBehalfOf: _onBehalfOf, ...signed } = b;
  return signed;
}

/** Deterministic order for published ballots: by voter key (unique per round), then canonical form. */
export function sortBallots<T extends { voterKey: string }>(ballots: readonly T[]): T[] {
  return [...ballots].sort((a, b) => cmp(a.voterKey, b.voterKey) || cmp(canonicalize(a), canonicalize(b)));
}

/** Hex sha256 over the JCS of the sorted published ballots. Any change to any ballot changes it. */
export function ballotsHash(ballots: readonly PublishedBallot[]): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalize(sortBallots(ballots)))));
}

/** Splits `poolCents` by `qf`, honouring `capCents`; returns cents per id and what could not be placed. */
function allocate(ids: string[], qf: Map<string, number>, poolCents: number, capCents: number | undefined) {
  const out = new Map<string, number>(ids.map((id) => [id, 0]));
  let remaining = poolCents;
  let active = ids.filter((id) => (qf.get(id) ?? 0) > 0);
  while (remaining > 0 && active.length) {
    const sum = active.reduce((s, id) => s + qf.get(id)!, 0);
    const raw = new Map(active.map((id) => [id, (remaining * qf.get(id)!) / sum]));
    const over = capCents === undefined ? [] : active.filter((id) => out.get(id)! + raw.get(id)! > capCents);
    if (over.length) {
      for (const id of over) {
        remaining -= capCents! - out.get(id)!;
        out.set(id, capCents!);
      }
      active = active.filter((id) => !over.includes(id));
      continue;
    }
    let placed = 0;
    for (const id of active) {
      const c = Math.floor(raw.get(id)! + 1e-9);
      out.set(id, out.get(id)! + c);
      placed += c;
    }
    let leftover = remaining - placed;
    const top = [...active].sort((a, b) => qf.get(b)! - qf.get(a)! || cmp(a, b))[0]!;
    const room = capCents === undefined ? leftover : Math.max(0, capCents - out.get(top)!);
    const give = Math.min(leftover, room);
    out.set(top, out.get(top)! + give);
    leftover -= give;
    remaining = leftover;
    break;
  }
  return { cents: out, unallocatedCents: Math.max(0, remaining) };
}

/**
 * Computes the round tally from published ballots. `proposals` are ids (or `{ id }`); `weights` maps a tier
 * to its weight (use `ROUND_WEIGHTS`). Throws when a ballot allocates to an unknown proposal or an invalid
 * vote count (the service refuses those at submission, so this only fires on tampered input).
 */
export function tally(
  ballots: readonly PublishedBallot[],
  proposals: readonly (string | { id: string })[],
  weights: Readonly<Record<string, number>>,
  pool: number,
  opts: TallyOptions = {},
): Tally {
  const ids = proposals.map((p) => (typeof p === 'string' ? p : p.id)).sort(cmp);
  const known = new Set(ids);
  const acc = new Map(ids.map((id) => [id, { rawVotes: 0, voters: 0, voiceSum: 0 }]));
  const sorted = sortBallots(ballots);
  for (const b of sorted) {
    const w = weights[b.tier] ?? 1;
    for (const pid of Object.keys(b.allocations ?? {}).sort(cmp)) {
      const v = b.allocations[pid]!;
      if (!known.has(pid)) throw new Error(`Ballot ${b.voterKey} allocates to unknown proposal ${pid}.`);
      if (!Number.isInteger(v) || v < 0) throw new Error(`Ballot ${b.voterKey} has an invalid vote count for ${pid}.`);
      if (v === 0) continue;
      const a = acc.get(pid)!;
      a.rawVotes += v;
      a.voters += 1;
      a.voiceSum += w * Math.sqrt(v);
    }
  }
  const qf = new Map(ids.map((id) => [id, round6(acc.get(id)!.voiceSum ** 2)]));
  const sumQf = ids.reduce((s, id) => s + qf.get(id)!, 0);
  const poolCents = Math.round(pool * 100);
  const cap = opts.matchingCap ?? null;
  const { cents, unallocatedCents } = allocate(ids, qf, poolCents, cap === null ? undefined : Math.round(cap * 100));

  const adjustments = [...(opts.adjustments ?? [])].map((a) => ({ ...a, delta: round2(a.delta) }));
  const adjBy = new Map<string, number>();
  for (const a of adjustments) {
    if (!known.has(a.proposalId)) throw new Error(`Adjustment refers to unknown proposal ${a.proposalId}.`);
    adjBy.set(a.proposalId, (adjBy.get(a.proposalId) ?? 0) + Math.round(a.delta * 100));
  }

  const entries: TallyEntry[] = ids.map((id) => {
    const a = acc.get(id)!;
    const adjCents = adjBy.get(id) ?? 0;
    return {
      id,
      rawVotes: a.rawVotes,
      voters: a.voters,
      voiceSum: round6(a.voiceSum),
      qf: qf.get(id)!,
      share: sumQf > 0 ? round6(qf.get(id)! / sumQf) : 0,
      matching: (cents.get(id)! + adjCents) / 100,
      adjustment: adjCents / 100,
    };
  });
  const totalCents = ids.reduce((s, id) => s + cents.get(id)! + (adjBy.get(id) ?? 0), 0);
  return {
    proposals: entries,
    pool: poolCents / 100,
    matchingCap: cap,
    weights: { ...weights },
    ballotCount: sorted.length,
    ballotsHash: ballotsHash(sorted),
    totalMatching: totalCents / 100,
    unallocated: unallocatedCents / 100,
    computedAt: opts.computedAt ?? new Date(0).toISOString(),
    adjustments,
  };
}
