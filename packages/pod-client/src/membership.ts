import { digestMultibase, toBase58btc, randomNonce, type VerifiableCredential } from '@passport/credential-core';
import { sha256 } from '@noble/hashes/sha2.js';
import type { AckResult, CommitItem, PodClient, RefreshResult, SessionInfo } from './client.js';
import { PodError, utf8 } from './util.js';
import type { Wallet } from './wallet.js';

/**
 * Opens a session for the client's pod: a member session (membership pair + current VACs) when the wallet holds
 * a complete pair, else a holder-only visitor session. The mount sets the `passport_session` cookie.
 */
export async function signIn(wallet: Wallet, client: PodClient, requireAuthority?: string[]): Promise<SessionInfo & { visitor: boolean }> {
  const pair = await wallet.membership(client.slug);
  if (!pair) return { ...(await client.visitorSession()), visitor: true };
  const creds = await wallet.selectFor(client.slug, []);
  const s = await client.session(creds, requireAuthority);
  await wallet.setTier(client.slug, s.tier);
  return { ...s, visitor: false };
}

const needsSession = (e: unknown) => e instanceof PodError && (e.code === 'UNAUTHENTICATED' || e.code === 'POD_MISMATCH' || e.code === 'MISSING_AUTHORITY');

/** Runs `fn`; when the pod asks for (another) session, signs in once and retries. */
export async function withSession<T>(wallet: Wallet, client: PodClient, fn: () => Promise<T>, requireAuthority?: string[]): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!needsSession(e)) throw e;
    await signIn(wallet, client, requireAuthority);
    return fn();
  }
}

/** Applies with the witnessed relationship with `contactDid`; stores and returns the grant (not yet accepted). */
export async function applyForMembership(wallet: Wallet, client: PodClient, contactDid: string): Promise<VerifiableCredential> {
  const c = await wallet.contact(contactDid);
  if (!c?.vwc || !c.vrcOut || !c.vrcIn) throw new Error('This relationship has not been witnessed yet.');
  const grant = await client.apply(c.vwc, c.vrcOut, c.vrcIn);
  await wallet.storeCredential(grant, { pod: client.slug });
  return grant;
}

/**
 * Consent: signs the acknowledgement of `grant` (only after the person pressed "I accept"), stores the pair and
 * the VACs, records the tier, then opens a member session.
 */
export async function acceptMembership(wallet: Wallet, client: PodClient, grant: VerifiableCredential): Promise<AckResult & { session?: SessionInfo }> {
  const r = await client.ack(grant);
  await wallet.storeCredential(grant, { pod: client.slug });
  await wallet.storeCredential(r.ackCredential, { pod: client.slug });
  await wallet.replaceVacs(client.slug, r.vacs);
  const until = r.vacs[0]?.validUntil;
  await wallet.updatePod(client.slug, { tier: r.member.tier, joinedAt: wallet.now().toISOString(), ...(until ? { effectiveUntil: until } : {}) });
  await wallet.setExplanation(client.slug, { tier: r.member.tier, explanation: r.explanation });
  let session: SessionInfo | undefined;
  try {
    session = await signIn(wallet, client);
  } catch {
    // The membership stands; signing in can be retried from the pod home.
  }
  return { member: r.member, vacs: r.vacs, explanation: r.explanation, ...(session ? { session } : {}) };
}

/** "Why this tier": `POST /authority/refresh` (signing in first when needed); stores the VACs and explanation. */
export async function refreshTier(wallet: Wallet, client: PodClient): Promise<RefreshResult> {
  const r = await withSession(wallet, client, () => client.refresh());
  await wallet.replaceVacs(client.slug, r.vacs);
  await wallet.setExplanation(client.slug, { tier: r.tier, explanation: r.explanation, ...(r.next ? { next: r.next } : {}) });
  const until = r.vacs.find((v) => v.credentialSubject?.['tier'] === r.tier)?.validUntil;
  await wallet.setTier(client.slug, r.tier, until);
  return r;
}

/** Salted commitment `H(salt ‖ my did ‖ their did ‖ scope)` (z-base58 sha256). */
export function commitmentFor(salt: string, me: string, them: string, scope: string): string {
  return toBase58btc(sha256(utf8(`${salt}|${me}|${them}|${scope}`)));
}

/**
 * Opt in to the trust index for one relationship (FR-TR, B3 §5 `index.commit`):
 * - `relationship`: the witnessed edge, with `witnessRef` = digest of the pod's witness credential;
 * - a vouch scope: a vouch this contact gave me, with `evidence: { vec }` (the index only counts endorsements
 *   issued to the person posting them).
 */
export async function optInToIndex(wallet: Wallet, client: PodClient, contactDid: string, what: 'relationship' | 'vouch'): Promise<{ accepted: number; duplicates: number }> {
  const c = await wallet.contact(contactDid);
  if (!c) throw new Error('That neighbor is not in your contacts.');
  const salt = randomNonce(16);
  let item: CommitItem;
  if (what === 'relationship') {
    if (!c.vwc) throw new Error('Only a witnessed relationship can be counted.');
    item = { commitment: commitmentFor(salt, c.myDid, c.did, 'relationship'), scope: 'relationship', witnessRef: digestMultibase(c.vwc) };
  } else {
    const scope = c.vecIn?.credentialSubject?.['object']?.value?.scope;
    if (!c.vecIn || (scope !== 'lives-here' && scope !== 'worked-with' && scope !== 'knows')) throw new Error('This neighbor has not vouched for you yet.');
    item = { commitment: commitmentFor(salt, c.myDid, c.did, scope), scope, evidence: { vec: c.vecIn } };
  }
  const r = await withSession(wallet, client, () => client.commit([item]));
  await wallet.updateContact(contactDid, { committed: [...(c.committed ?? []), { scope: item.scope, commitment: item.commitment, at: wallet.now().toISOString() }] });
  return { accepted: r.accepted, duplicates: r.duplicates };
}
