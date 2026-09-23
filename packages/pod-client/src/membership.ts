import { digestMultibase, toBase58btc, toBase64url, verifyDocument, type DataIntegrityProof, type DidResolver, type VerifiableCredential } from '@passport/credential-core';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { PodRow } from './db.js';
import type { AckResult, CommitItem, PodClient, RefreshResult, SessionInfo } from './client.js';
import { defaultResolver, PodError, utf8 } from './util.js';
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

/**
 * "Refresh my session": presents the passport to the pod again so the session cookie carries every credential
 * the wallet now holds (new permissions from a grant, a refresh, or an imported credential such as `pay:receive`).
 * A wallet without a membership pair gets a fresh visitor session.
 */
export function renewSession(wallet: Wallet, client: PodClient): Promise<SessionInfo & { visitor: boolean }> {
  return signIn(wallet, client);
}

/**
 * Re-opens the member session after the wallet gained credentials for `client`'s pod, so the cookie carries the
 * new authorities straight away (issue 6 of the MVP e2e report). Best effort: without a complete membership pair
 * there is nothing new to present and nothing happens; a failure is returned, never thrown (the credential is
 * already stored, and the person can press "Refresh my session").
 */
export async function renewAfterNewCredentials(wallet: Wallet, client: PodClient): Promise<{ session?: SessionInfo; error?: string }> {
  if (!(await wallet.membership(client.slug))) return {};
  try {
    return { session: await signIn(wallet, client) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Stores a credential someone handed over (Settings → "Add a credential"), filed under `client`'s pod, then
 * re-opens the session so a newly added permission works at once.
 */
export async function addPodCredential(wallet: Wallet, client: PodClient, vc: VerifiableCredential): Promise<{ digest: string; session?: SessionInfo; error?: string }> {
  const digest = await wallet.storeCredential(vc, { pod: client.slug });
  return { digest, ...(await renewAfterNewCredentials(wallet, client)) };
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

/**
 * Applies with the witnessed relationship with `contactDid`; stores and returns the grant (not yet accepted).
 * When the pod refuses the witness credential (`WITNESS_INVALID`), it is dropped and remembered as refused, so the
 * wallet goes back to waiting for a valid witness result.
 */
export async function applyForMembership(wallet: Wallet, client: PodClient, contactDid: string): Promise<VerifiableCredential> {
  const c = await wallet.contact(contactDid);
  if (!c?.vwc || !c.vrcOut || !c.vrcIn) throw new Error('This relationship has not been witnessed yet.');
  let grant: VerifiableCredential;
  try {
    grant = await client.apply(c.vwc, c.vrcOut, c.vrcIn);
  } catch (e) {
    if (e instanceof PodError && e.code === 'WITNESS_INVALID') {
      await wallet.updateContact(contactDid, { vwc: undefined, refusedVwcs: [...(c.refusedVwcs ?? []), digestMultibase(c.vwc)] });
    }
    throw e;
  }
  await wallet.storeCredential(grant, { pod: client.slug });
  return grant;
}

/**
 * Checks a membership offer before the consent screen shows it: it must come from a pod this passport has joined
 * (looked up by the grant's issuer DID), be made out to the persona used there, be signed by that pod, and be
 * current. Returns that pod; throws one plain sentence otherwise.
 */
export async function verifyGrant(wallet: Wallet, grant: unknown, resolver: DidResolver = defaultResolver()): Promise<PodRow> {
  const g = grant as VerifiableCredential | undefined;
  const isGrant = Array.isArray(g?.type) && g!.type.includes('MembershipCredential') && typeof g!.credentialSubject?.['digestMultibase'] !== 'string';
  if (!g || !isGrant) throw new Error('This is not a membership offer.');
  const pod = (await wallet.pods()).find((p) => p.did === g.issuer);
  if (!pod) throw new Error('This membership offer is not from a pod your passport has joined.');
  if (g.credentialSubject.id !== pod.personaDid) throw new Error(`This membership offer from ${pod.manifest.identity.name} was made out to a different identifier.`);
  const r = g.proof ? await verifyDocument(g as VerifiableCredential & { proof: DataIntegrityProof }, resolver, { proofPurpose: 'assertionMethod' }).catch(() => ({ ok: false, controller: undefined })) : { ok: false, controller: undefined };
  if (!r.ok || r.controller !== pod.did) throw new Error(`This membership offer is not signed by ${pod.manifest.identity.name}.`);
  if (!g.validUntil || Date.parse(g.validUntil) <= wallet.now().getTime()) throw new Error('This membership offer has expired.');
  return pod;
}

/**
 * Consent: signs the acknowledgement of `grant` (only after the person pressed "I accept"), stores the pair and
 * the VACs, records the tier, then opens a member session. The grant is verified first (`verifyGrant`).
 */
export async function acceptMembership(wallet: Wallet, client: PodClient, grant: VerifiableCredential, opts: { resolver?: DidResolver } = {}): Promise<AckResult & { session?: SessionInfo }> {
  const pod = await verifyGrant(wallet, grant, opts.resolver);
  if (pod.slug !== client.slug) throw new Error(`This membership offer is from ${pod.manifest.identity.name}, not the pod you are signed in to.`);
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

/**
 * "Why this tier": `POST /authority/refresh` (signing in first when needed); stores the VACs and explanation, then
 * re-opens the session so the cookie carries the refreshed permissions (a new tier's actions work at once).
 */
export async function refreshTier(wallet: Wallet, client: PodClient): Promise<RefreshResult & { session?: SessionInfo }> {
  const r = await withSession(wallet, client, () => client.refresh());
  await wallet.replaceVacs(client.slug, r.vacs);
  await wallet.setExplanation(client.slug, { tier: r.tier, explanation: r.explanation, ...(r.next ? { next: r.next } : {}) });
  const until = r.vacs.find((v) => v.credentialSubject?.['tier'] === r.tier)?.validUntil;
  await wallet.setTier(client.slug, r.tier, until);
  const { session } = await renewAfterNewCredentials(wallet, client);
  return { ...r, ...(session ? { session } : {}) };
}

/**
 * Commitment salt, derived (not random) so a retry re-posts the SAME commitment and the index reports a duplicate
 * instead of counting twice: HKDF-SHA256(ikm = my identifier's seed, info = `index-commit:<ref>`), 16 bytes, where
 * `ref` is the witness credential's digest (relationship) or the vouch's digest.
 */
export function commitSalt(seed: Uint8Array, ref: string): string {
  return toBase64url(hkdf(sha256, seed, undefined, utf8(`index-commit:${ref}`), 16));
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
  const me = await wallet.keyFor(c.myDid);
  if (!me) throw new Error('This passport no longer holds the identifier used for that relationship.');
  let item: CommitItem;
  if (what === 'relationship') {
    if (!c.vwc) throw new Error('Only a witnessed relationship can be counted.');
    const witnessRef = digestMultibase(c.vwc);
    item = { commitment: commitmentFor(commitSalt(me.privateKey, witnessRef), c.myDid, c.did, 'relationship'), scope: 'relationship', witnessRef };
  } else {
    const scope = c.vecIn?.credentialSubject?.['object']?.value?.scope;
    if (!c.vecIn || (scope !== 'lives-here' && scope !== 'worked-with' && scope !== 'knows')) throw new Error('This neighbor has not vouched for you yet.');
    const salt = commitSalt(me.privateKey, digestMultibase(c.vecIn));
    item = { commitment: commitmentFor(salt, c.myDid, c.did, scope), scope, evidence: { vec: c.vecIn } };
  }
  const r = await withSession(wallet, client, () => client.commit([item]));
  const prior = (c.committed ?? []).filter((x) => x.commitment !== item.commitment);
  await wallet.updateContact(contactDid, { committed: [...prior, { scope: item.scope, commitment: item.commitment, at: wallet.now().toISOString() }] });
  return { accepted: r.accepted, duplicates: r.duplicates };
}
