import {
  createPresentation,
  digestMultibase,
  generateKeyPair,
  keyPairFromSeed,
  type DidScope,
  type KeyPair,
  type VerifiableCredential,
  type VerifiablePresentation,
} from '@passport/credential-core';
import type { BioregionManifest } from '@passport/tenant-config';
import { parseRequirement, type Tier } from '@passport/vocab';
import { DEFAULT_DB_NAME, WalletDb, type ContactRow, type CredentialRow, type EventRow, type IdentifierRow, type PodExplanation, type PodRow } from './db.js';
import { credentialKind, dtgType, isCurrent, podDomainOf, vacActions } from './util.js';

export interface WalletOptions {
  /** IndexedDB database name (tests and the in-page demo use their own). */
  name?: string;
  now?: () => Date;
}

const CREATED_KEY = 'wallet.createdAt';
const ROOT_KEY = 'wallet.root';
const LAST_POD_KEY = 'wallet.lastPod';

/**
 * The resident's passport: keys, credentials, pods, contacts and events in IndexedDB. Keys never leave the device
 * except through `exportBackup` / `createShares` (see recovery.ts), which the person triggers.
 */
export class Wallet {
  readonly db: WalletDb;
  readonly now: () => Date;

  constructor(opts: WalletOptions = {}) {
    this.db = new WalletDb(opts.name ?? DEFAULT_DB_NAME);
    this.now = opts.now ?? (() => new Date());
  }

  private iso(): string {
    return this.now().toISOString();
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────────────────────────

  async exists(): Promise<boolean> {
    return (await this.db.settings.get(CREATED_KEY)) !== undefined;
  }

  /**
   * Creates the passport: a root identifier (scope `public`; the MVP stand-in for the person's `did:plc`,
   * ADR-21) so the first backup already holds a key. Idempotent.
   */
  async init(): Promise<{ rootDid: string }> {
    const existing = await this.setting<string>(ROOT_KEY);
    if (existing) return { rootDid: existing };
    const key = generateKeyPair();
    const createdAt = this.iso();
    await this.db.transaction('rw', this.db.identifiers, this.db.settings, async () => {
      await this.db.identifiers.put({ did: key.did, scope: 'public', seed: key.privateKey, createdAt });
      await this.db.settings.bulkPut([
        { key: CREATED_KEY, value: createdAt },
        { key: ROOT_KEY, value: key.did },
      ]);
    });
    return { rootDid: key.did };
  }

  async rootDid(): Promise<string | undefined> {
    return this.setting<string>(ROOT_KEY);
  }

  /** Deletes the whole wallet database from this device. */
  async forget(): Promise<void> {
    this.db.close();
    await this.db.delete();
  }

  // ── settings ────────────────────────────────────────────────────────────────────────────────────

  async setting<T>(key: string): Promise<T | undefined> {
    return (await this.db.settings.get(key))?.value as T | undefined;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db.settings.put({ key, value });
  }

  async lastPod(): Promise<string | undefined> {
    return this.setting<string>(LAST_POD_KEY);
  }

  async setLastPod(slug: string): Promise<void> {
    await this.setSetting(LAST_POD_KEY, slug);
  }

  /** Next per-sender ceremony message sequence number (B3 §5 offline replay). */
  async nextSeq(did: string): Promise<number> {
    const key = `seq:${did}`;
    return this.db.transaction('rw', this.db.settings, async () => {
      const n = ((await this.setting<number>(key)) ?? 0) + 1;
      await this.setSetting(key, n);
      return n;
    });
  }

  // ── identifiers ─────────────────────────────────────────────────────────────────────────────────

  private async store(scope: DidScope, p: { pod?: string; counterparty?: string }): Promise<KeyPair> {
    const key = generateKeyPair();
    const row: IdentifierRow = { did: key.did, scope, seed: key.privateKey, createdAt: this.iso() };
    if (p.pod) row.pod = p.pod;
    if (p.counterparty) row.counterparty = p.counterparty;
    await this.db.identifiers.put(row);
    return key;
  }

  /**
   * A directed persona for `pod` (did:key from a fresh random seed, scope `directed`). Returns the pod's existing
   * persona when there is one. `reuse` = an identifier already used with another pod (FR-ID-6: the person chose
   * "reuse my identifier"), in which case no new key is minted.
   */
  async mintPersona(pod: string, opts: { reuse?: string } = {}): Promise<KeyPair> {
    const current = await this.personaFor(pod);
    if (current) return current;
    // After recovery from shares the keys are back but the pod list is not: reuse the pod's recovered persona.
    const recovered = await this.db.identifiers.where('pod').equals(pod).filter((r) => r.scope === 'directed').first();
    if (recovered && !opts.reuse) return keyPairFromSeed(new Uint8Array(recovered.seed));
    if (opts.reuse) {
      const reused = await this.keyFor(opts.reuse);
      if (!reused) throw new Error('That identifier is not in this passport.');
      return reused;
    }
    return this.store('directed', { pod });
  }

  /** A pairwise identifier for one relationship in `pod` (scope `pairwise`). */
  async mintPairwise(pod: string, counterparty?: string): Promise<KeyPair> {
    return this.store('pairwise', counterparty ? { pod, counterparty } : { pod });
  }

  async setCounterparty(did: string, counterparty: string): Promise<void> {
    await this.db.identifiers.update(did, { counterparty });
  }

  async keyFor(did: string): Promise<KeyPair | undefined> {
    const row = await this.db.identifiers.get(did);
    return row ? keyPairFromSeed(new Uint8Array(row.seed)) : undefined;
  }

  async personaFor(slug: string): Promise<KeyPair | undefined> {
    const pod = await this.db.pods.get(slug);
    return pod ? this.keyFor(pod.personaDid) : undefined;
  }

  async identifiers(): Promise<IdentifierRow[]> {
    return this.db.identifiers.orderBy('did').toArray();
  }

  // ── pods ────────────────────────────────────────────────────────────────────────────────────────

  /** Adds (or refreshes the manifest of) a pod with the persona the person chose. */
  async addPod(manifest: BioregionManifest, personaDid: string): Promise<PodRow> {
    const slug = manifest.identity.slug;
    const prior = await this.db.pods.get(slug);
    const row: PodRow = prior
      ? { ...prior, manifest, did: manifest.identity.did }
      : { slug, manifest, did: manifest.identity.did, personaDid, tier: 'T0', addedAt: this.iso() };
    await this.db.pods.put(row);
    return row;
  }

  async pods(): Promise<PodRow[]> {
    return this.db.pods.orderBy('slug').toArray();
  }

  async pod(slug: string): Promise<PodRow | undefined> {
    return this.db.pods.get(slug);
  }

  async updatePod(slug: string, patch: Partial<Omit<PodRow, 'slug'>>): Promise<void> {
    await this.db.pods.update(slug, patch);
  }

  async setExplanation(slug: string, e: Omit<PodExplanation, 'at'>): Promise<void> {
    await this.db.pods.update(slug, { lastExplanation: { ...e, at: this.iso() }, tier: e.tier });
  }

  // ── credentials ─────────────────────────────────────────────────────────────────────────────────

  /** Stores a credential exactly as received; returns its digest. */
  async storeCredential(vc: VerifiableCredential, opts: { pod?: string } = {}): Promise<string> {
    const digest = digestMultibase(vc);
    const row: CredentialRow = {
      digest,
      type: dtgType(vc),
      kind: credentialKind(vc),
      issuer: vc.issuer,
      subject: vc.credentialSubject?.id ?? '',
      raw: vc,
      receivedAt: this.iso(),
      status: 'active',
    };
    if (opts.pod) row.pod = opts.pod;
    if (vc.validUntil) row.validUntil = vc.validUntil;
    const prior = await this.db.credentials.get(digest);
    if (prior) row.receivedAt = prior.receivedAt;
    await this.db.credentials.put(row);
    return digest;
  }

  async credentials(pod?: string): Promise<CredentialRow[]> {
    const rows = pod ? await this.db.credentials.where('pod').equals(pod).toArray() : await this.db.credentials.toArray();
    return rows.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  async credential(digest: string): Promise<CredentialRow | undefined> {
    return this.db.credentials.get(digest);
  }

  /** The latest current membership pair with `slug` (grant from the pod, ack from me), if complete. */
  async membership(slug: string): Promise<{ grant: VerifiableCredential; ack: VerifiableCredential } | undefined> {
    const pod = await this.db.pods.get(slug);
    if (!pod) return undefined;
    const now = this.now();
    const rows = await this.credentials(slug);
    for (const g of rows.filter((r) => r.kind === 'membership-grant' && r.issuer === pod.did && isCurrent(r.raw, now))) {
      const ack = rows.find(
        (r) => r.kind === 'membership-ack' && r.raw.credentialSubject['digestMultibase'] === g.digest && r.issuer === g.subject && isCurrent(r.raw, now),
      );
      if (ack) return { grant: g.raw, ack: ack.raw };
    }
    return undefined;
  }

  /** Current, not superseded authority credentials from `slug`'s pod, newest first. */
  async activeVacs(slug: string): Promise<VerifiableCredential[]> {
    const pod = await this.db.pods.get(slug);
    if (!pod) return [];
    const now = this.now();
    return (await this.credentials(slug))
      .filter((r) => r.kind === 'authority' && r.status !== 'superseded' && r.issuer === pod.did && isCurrent(r.raw, now))
      .map((r) => r.raw);
  }

  /** Every authority action the wallet can currently prove for `slug`. */
  async authorities(slug: string): Promise<string[]> {
    return [...new Set((await this.activeVacs(slug)).flatMap(vacActions))];
  }

  /**
   * Replaces the pod's authority set with the server's list of currently valid VACs (refresh/ack), marking older
   * ones superseded so a revoked or lapsed VAC is never presented.
   */
  async replaceVacs(slug: string, vacs: VerifiableCredential[]): Promise<void> {
    const keep = new Set<string>();
    for (const vc of vacs) keep.add(await this.storeCredential(vc, { pod: slug }));
    const rows = await this.db.credentials.where('pod').equals(slug).toArray();
    await this.db.credentials.bulkPut(
      rows.filter((r) => r.kind === 'authority').map((r) => ({ ...r, status: keep.has(r.digest) ? 'active' : 'superseded' }) as CredentialRow),
    );
  }

  /**
   * Chooses what to present for `requirements` (manifest / pay-request strings such as `MembershipCredential:pod`,
   * `AuthorityCredential:credit:account`). No requirements = the membership pair and every active VAC.
   * Throws a one-sentence error when the wallet cannot meet a requirement.
   */
  async selectFor(slug: string, requirements: string[] = []): Promise<VerifiableCredential[]> {
    const pod = await this.db.pods.get(slug);
    if (!pod) throw new Error('This passport has not joined that pod yet.');
    const pair = await this.membership(slug);
    const vacs = await this.activeVacs(slug);
    if (!requirements.length) {
      if (!pair) throw new Error(`You are not a member of ${pod.manifest.identity.name} yet.`);
      return [pair.grant, pair.ack, ...vacs];
    }
    const out: VerifiableCredential[] = [];
    const add = (vc: VerifiableCredential) => {
      if (!out.includes(vc)) out.push(vc);
    };
    for (const input of requirements) {
      const { type, scope } = parseRequirement(input);
      if (type === 'MembershipCredential') {
        if (!pair) throw new Error(`This needs membership in ${pod.manifest.identity.name}, which your passport does not hold yet.`);
        add(pair.grant);
        add(pair.ack);
      } else if (type === 'AuthorityCredential') {
        const vac = vacs.find((v) => vacActions(v).includes(scope));
        if (!vac) throw new Error(`This needs the "${scope}" permission, which your passport does not carry.`);
        add(vac);
      } else {
        throw new Error(`Your passport cannot present a ${type}.`);
      }
    }
    // Authority is only accepted alongside membership of the issuing pod.
    if (out.some((v) => credentialKind(v) === 'authority') && pair) {
      add(pair.grant);
      add(pair.ack);
    }
    return out;
  }

  /** `presentTo`: a VP for `slug` meeting `requirements`, signed by the pod persona and bound to challenge + domain. */
  async presentTo(slug: string, requirements: string[], binding: { challenge: string; domain?: string }): Promise<VerifiablePresentation> {
    const pod = await this.db.pods.get(slug);
    const persona = await this.personaFor(slug);
    if (!pod || !persona) throw new Error('This passport has not joined that pod yet.');
    const creds = await this.selectFor(slug, requirements);
    return createPresentation(creds, persona, { challenge: binding.challenge, domain: binding.domain ?? podDomainOf(slug, pod.did) });
  }

  // ── contacts & events ───────────────────────────────────────────────────────────────────────────

  async contacts(pod?: string): Promise<ContactRow[]> {
    const rows = pod ? await this.db.contacts.where('pod').equals(pod).toArray() : await this.db.contacts.toArray();
    return rows.sort((a, b) => b.formedAt.localeCompare(a.formedAt));
  }

  async contact(did: string): Promise<ContactRow | undefined> {
    return this.db.contacts.get(did);
  }

  async putContact(row: ContactRow): Promise<void> {
    await this.db.contacts.put(row);
  }

  async updateContact(did: string, patch: Partial<Omit<ContactRow, 'did'>>): Promise<void> {
    await this.db.contacts.update(did, patch);
  }

  async events(pod: string): Promise<EventRow[]> {
    return (await this.db.events.where('pod').equals(pod).toArray()).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  async putEvents(rows: EventRow[]): Promise<void> {
    await this.db.events.bulkPut(rows);
  }

  async setTier(slug: string, tier: Tier, effectiveUntil?: string): Promise<void> {
    await this.db.pods.update(slug, effectiveUntil ? { tier, effectiveUntil } : { tier });
  }
}

/** Opens (and creates on first use) the wallet: `createWallet()` in the plan. */
export async function createWallet(opts: WalletOptions = {}): Promise<Wallet> {
  const w = new Wallet(opts);
  await w.init();
  return w;
}

/** Opens the wallet without creating one. */
export function openWallet(opts: WalletOptions = {}): Wallet {
  return new Wallet(opts);
}
