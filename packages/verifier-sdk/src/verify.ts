import {
  checkAuthorityChain,
  checkDelegationChain,
  digestMultibase,
  MAX_VALIDITY_DAYS,
  isMembershipPairComplete,
  verifyDocument,
  type DataIntegrityProof,
  type DidResolver,
  type VerifiableCredential,
  type VerifiablePresentation,
} from '@passport/credential-core';
import { PREDICATES, TIERS, tierRank, type Tier } from '@passport/vocab';
import { isRevoked, type StatusFetch } from './status.js';

/** Stable error codes (plan §4.4). */
export const ERROR_CODES = [
  'NO_MEMBERSHIP',
  'PAIR_INCOMPLETE',
  'DIGEST_MISMATCH',
  'EXPIRED',
  'POD_MISMATCH',
  'MISSING_AUTHORITY',
  'BROADENED_ATTENUATION',
  'CHAIN_TOO_DEEP',
  'UNKNOWN_PREDICATE',
  'BAD_PROOF',
  'BAD_CHALLENGE',
  'UPSTREAM_UNAVAILABLE',
] as const;
export type VerifyErrorCode = (typeof ERROR_CODES)[number];

export interface VerifyPolicy {
  acceptedPods: string[] | 'registry';
  requireMembership?: boolean;
  requireAuthority?: string[];
  allowDelegation?: boolean;
  maxClockSkewSec?: number;
  statusCheck?: 'ifPresent' | 'never';
  /** Required (with `domain`) unless `allowReplay` is true. */
  challenge?: string;
  domain?: string;
  /** Explicit opt-out of challenge/domain binding (tests, offline re-verification). */
  allowReplay?: boolean;
  registry?: { resolvePods(): Promise<string[]> };
  /** Optional display names for pod DIDs, used in explanations ("Boulder Commons"). */
  podNames?: Record<string, string>;
}

export interface VerifyResult {
  ok: boolean;
  subject?: string;
  pod?: string;
  tier?: string;
  authorities: string[];
  delegatedFor?: string;
  explanation: string[];
  error?: { code: VerifyErrorCode | string; message: string };
}

export interface VerifyDeps {
  resolver: DidResolver;
  now?: () => Date;
  /** Fetches a status list (BitstringStatusListCredential JSON, or the raw decoded bitstring). */
  statusFetch?: StatusFetch;
}

const DEFAULT_SKEW_SEC = 300;
const MAX_SKEW_SEC = 600;
const DAY_MS = 86_400_000;
const CEILING_MESSAGE = 'This credential was issued with a longer validity than the profile allows.';
const PAY_RECEIVE_UNSCOPED = 'This gate needs pay:receive scoped to an enterprise.';

/** A `requireAuthority` entry: `action` or `action@<scopeDid>` (e.g. `pay:receive@did:web:…:moxie-bread`). */
export function parseAuthorityRequirement(entry: string): { action: string; scope?: string } {
  const at = entry.indexOf('@');
  if (at < 0) return { action: entry };
  const action = entry.slice(0, at);
  const scope = entry.slice(at + 1);
  if (!action || !scope.startsWith('did:')) throw new Error(`Invalid scoped authority requirement: ${entry}`);
  return { action, scope };
}
const MAX_ATTENUATION_HOPS = 8;

const isType = (vc: VerifiableCredential, t: string): boolean =>
  !!vc && Array.isArray(vc.type) && vc.type.includes(t);

const day = (iso: string | undefined): string => (iso ? iso.slice(0, 10) : 'an unknown date');

class Refusal extends Error {
  constructor(public code: VerifyErrorCode, message: string) {
    super(message);
  }
}

interface Ctx {
  holder: string;
  now: number;
  skewMs: number;
  explanation: string[];
  podName(did: string): string;
}

/** Validity window with clock-skew tolerance. Returns a sentence when the credential is not usable now. */
function windowProblem(vc: VerifiableCredential, label: string, ctx: Ctx): string | undefined {
  const from = Date.parse(vc.validFrom);
  if (Number.isNaN(from)) return `This ${label} has an unreadable start date.`;
  if (from - ctx.skewMs > ctx.now) return `This ${label} is not valid until ${day(vc.validFrom)}.`;
  if (vc.validUntil !== undefined) {
    const until = Date.parse(vc.validUntil);
    if (Number.isNaN(until)) return `This ${label} has an unreadable expiry date.`;
    if (until + ctx.skewMs <= ctx.now) return `This ${label} expired on ${day(vc.validUntil)}.`;
  }
  return undefined;
}

function friendlyDid(did: string): string {
  if (did.startsWith('did:web:')) {
    const parts = did.split(':');
    return decodeURIComponent(parts[parts.length - 1] ?? did);
  }
  return did.length > 32 ? `${did.slice(0, 20)}…${did.slice(-6)}` : did;
}

/**
 * Verify a DTG presentation at a gate (B3 §10). Never throws for bad input: every refusal comes back as
 * `{ ok: false, error: { code, message } }` with `message` being one plain sentence, also appended to
 * `explanation`.
 */
export async function verifyDTG(
  presentation: VerifiablePresentation,
  policy: VerifyPolicy,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const skew = policy?.maxClockSkewSec ?? DEFAULT_SKEW_SEC;
  if (typeof skew !== 'number' || !Number.isFinite(skew) || skew < 0 || skew > MAX_SKEW_SEC) {
    throw new Error('maxClockSkewSec must be a finite number between 0 and 600');
  }
  if (policy.acceptedPods === 'registry' && !policy.registry) {
    throw new Error('policy.acceptedPods is "registry" but no registry was provided.');
  }
  for (const entry of policy.requireAuthority ?? []) parseAuthorityRequirement(entry);
  const explanation: string[] = [];
  const result: VerifyResult = { ok: false, authorities: [], explanation };
  try {
    await run(presentation, policy, deps, result);
    result.ok = true;
    return result;
  } catch (e) {
    const refusal =
      e instanceof Refusal
        ? e
        : new Refusal('BAD_PROOF', `This presentation could not be read: ${e instanceof Error ? e.message : String(e)}`);
    result.ok = false;
    result.authorities = [];
    delete result.tier;
    delete result.delegatedFor;
    result.error = { code: refusal.code, message: refusal.message };
    explanation.push(refusal.message);
    return result;
  }
}

async function run(vp: VerifiablePresentation, policy: VerifyPolicy, deps: VerifyDeps, result: VerifyResult): Promise<void> {
  const explanation = result.explanation;
  const now = (deps.now ?? (() => new Date()))().getTime();
  const skewMs = (policy.maxClockSkewSec ?? DEFAULT_SKEW_SEC) * 1000;

  // ── 1. presentation proof ────────────────────────────────────────────────────────────────────────
  if (!vp || typeof vp !== 'object' || typeof vp.holder !== 'string' || !vp.holder) {
    throw new Refusal('BAD_PROOF', 'This presentation does not name its holder.');
  }
  if (!Array.isArray(vp.type) || !vp.type.includes('VerifiablePresentation')) {
    throw new Refusal('BAD_PROOF', 'This is not a verifiable presentation.');
  }
  const holder = vp.holder;
  result.subject = holder;
  const proof = vp.proof as DataIntegrityProof | undefined;
  if (!proof) throw new Refusal('BAD_PROOF', 'This presentation is not signed by its holder.');
  if (proof.proofPurpose !== 'authentication') {
    throw new Refusal('BAD_PROOF', 'This presentation was not signed for sign-in (authentication).');
  }
  if (!policy.allowReplay && (!policy.challenge || !policy.domain)) {
    throw new Refusal('BAD_CHALLENGE', 'This gate requires a fresh challenge.');
  }
  if (policy.challenge !== undefined && proof.challenge !== policy.challenge) {
    throw new Refusal('BAD_CHALLENGE', 'This presentation answers a different challenge, so it may be a replay.');
  }
  if (policy.domain !== undefined && proof.domain !== policy.domain) {
    throw new Refusal('BAD_CHALLENGE', `This presentation was made for ${proof.domain ?? 'another site'}, not ${policy.domain}.`);
  }
  const vpCheck = await verifyDocument(vp as VerifiablePresentation & { proof: DataIntegrityProof }, deps.resolver, {
    proofPurpose: 'authentication',
    ...(policy.challenge !== undefined ? { challenge: policy.challenge } : {}),
    ...(policy.domain !== undefined ? { domain: policy.domain } : {}),
  });
  if (!vpCheck.ok) throw new Refusal('BAD_PROOF', `The holder's signature on this presentation did not check out (${vpCheck.error ?? 'unknown error'}).`);
  explanation.push('The presentation is signed by its holder.');

  // ── 2. every credential proof ────────────────────────────────────────────────────────────────────
  const creds = Array.isArray(vp.verifiableCredential) ? vp.verifiableCredential : [];
  for (const [i, vc] of creds.entries()) {
    const label = Array.isArray(vc?.type) ? (vc.type.find((t) => t !== 'VerifiableCredential') ?? 'credential') : 'credential';
    if (!vc?.proof) throw new Refusal('BAD_PROOF', `Credential ${i + 1} (${label}) is not signed.`);
    const r = await verifyDocument(vc as VerifiableCredential & { proof: DataIntegrityProof }, deps.resolver, {
      proofPurpose: 'assertionMethod',
    });
    if (!r.ok) throw new Refusal('BAD_PROOF', `Credential ${i + 1} (${label}) has a signature that did not check out (${r.error ?? 'unknown error'}).`);
  }
  if (creds.length) explanation.push(`All ${creds.length} credential signatures check out.`);

  // ── 6. (early) statements with unknown predicates never belong at a gate ─────────────────────────
  const known = new Set<string>(Object.values(PREDICATES));
  for (const vc of creds) {
    if (!isType(vc, 'StatementCredential')) continue;
    const predicate = vc.credentialSubject?.['predicate'];
    if (typeof predicate !== 'string' || !known.has(predicate)) {
      throw new Refusal('UNKNOWN_PREDICATE', `This presentation carries a statement with an unknown predicate (${String(predicate)}), so it was refused.`);
    }
  }

  // ── B3 §2 validity ceilings on what is presented ─────────────────────────────────────────────────
  for (const vc of creds) {
    let maxDays: number | undefined;
    if (isType(vc, 'MembershipCredential')) maxDays = MAX_VALIDITY_DAYS.membership;
    else if (isType(vc, 'InvitationCredential')) maxDays = MAX_VALIDITY_DAYS.invitation;
    else if (isType(vc, 'AuthorityCredential')) {
      maxDays = vc.credentialSubject?.['authority']?.parent ? MAX_VALIDITY_DAYS.attenuatedAuthority : MAX_VALIDITY_DAYS.authority;
    }
    if (maxDays === undefined || vc.validUntil === undefined) continue;
    if (Date.parse(vc.validUntil) - Date.parse(vc.validFrom) > maxDays * DAY_MS) throw new Refusal('EXPIRED', CEILING_MESSAGE);
  }

  // ── accepted pods ────────────────────────────────────────────────────────────────────────────────
  let accepted: string[];
  if (policy.acceptedPods === 'registry') {
    try {
      accepted = await policy.registry!.resolvePods();
      if (!Array.isArray(accepted)) throw new Error('registry returned no list');
    } catch {
      throw new Refusal('UPSTREAM_UNAVAILABLE', 'The list of accepted pods could not be loaded right now, so this gate cannot decide.');
    }
  } else accepted = Array.isArray(policy.acceptedPods) ? policy.acceptedPods : [];
  const acceptedSet = new Set(accepted);

  const ctx: Ctx = {
    holder,
    now,
    skewMs,
    explanation,
    podName: (did) => policy.podNames?.[did] ?? friendlyDid(did),
  };

  // ── 3. membership ────────────────────────────────────────────────────────────────────────────────
  const requireMembership = policy.requireMembership ?? true;
  const pod = checkMembership(creds, acceptedSet, ctx, requireMembership);
  if (pod) result.pod = pod;

  // ── 4 + 5. authorities, own first, delegation only for what the holder cannot satisfy ─────────────
  const required = (policy.requireAuthority ?? []).map((entry) => ({ entry, ...parseAuthorityRequirement(entry) }));
  const vdcs = creds.filter((vc) => isType(vc, 'DelegationCredential'));
  // Grants carry `delegation.scope` and no `accepts`; acceptances carry `delegation.accepts` (grant digest).
  const vdcGrants = vdcs.filter((vc) => Array.isArray(vc.credentialSubject?.['delegation']?.scope) && !vc.credentialSubject['delegation'].accepts);
  const vdcAcceptances = vdcs.filter((vc) => typeof vc.credentialSubject?.['delegation']?.accepts === 'string');
  const delegationAllowed = !!policy.allowDelegation;
  if (vdcs.length && !delegationAllowed) {
    explanation.push('Delegations in this presentation were ignored because this gate does not accept them.');
  }

  const vacs = creds.filter((vc) => isType(vc, 'AuthorityCredential'));
  const byDigest = new Map<string, VerifiableCredential>();
  for (const vc of vacs) byDigest.set(digestMultibase(vc), vc);
  const podOk = (issuer: string) => (pod ? issuer === pod : acceptedSet.has(issuer));
  const isPodScope = (scope: unknown) => typeof scope === 'string' && (pod ? scope === pod : acceptedSet.has(scope));

  /** First valid VAC of `subject` for the requirement, or the first problem, or nothing. */
  const findAuthority = (subject: string, req: { action: string; scope?: string }) => {
    const candidates = vacs.filter((vc) => {
      const a = vc.credentialSubject?.['authority'];
      if (vc.credentialSubject?.id !== subject || !a || !Array.isArray(a.actions) || !a.actions.includes(req.action)) return false;
      return req.scope ? a.scope === req.scope : isPodScope(a.scope);
    });
    let problem: Refusal | undefined;
    for (const vc of candidates) {
      const p = authorityProblem(vc, byDigest, podOk, ctx);
      if (!p) return { vc };
      problem ??= p;
    }
    return { problem };
  };

  const describe = (vc: VerifiableCredential, action: string, via?: string): string => {
    const a = vc.credentialSubject['authority'];
    const until = day(vc.validUntil);
    if (action === 'pay:receive') return `Authority to receive payments at ${friendlyDid(a.scope)} is valid until ${until}.`;
    const where = isPodScope(a.scope) ? '' : ` at ${friendlyDid(a.scope)}`;
    return `Authority ${action}${where} is valid until ${until}${via ? `, held by ${friendlyDid(via)} and exercised by delegation` : ''}.`;
  };

  let principal: string | undefined;
  let delegatedScope: Set<string> | undefined;
  for (const req of required) {
    if (req.action === 'pay:receive' && !req.scope) throw new Refusal('MISSING_AUTHORITY', PAY_RECEIVE_UNSCOPED);
    const own = findAuthority(holder, req);
    if (own.vc) {
      explanation.push(describe(own.vc, req.action));
      continue;
    }
    const chain = delegationAllowed ? delegationChainFor(vdcGrants, req.action, ctx) : undefined;
    if (!chain) {
      throw own.problem ?? new Refusal('MISSING_AUTHORITY', `No authority credential in this presentation gives you the right to ${req.entry}.`);
    }
    const via = checkDelegation(chain, vdcAcceptances, req.action, ctx);
    if (principal && principal !== via.principal) {
      throw new Refusal('MISSING_AUTHORITY', 'This presentation mixes delegations from different groups, so it was refused.');
    }
    if (!principal) {
      principal = via.principal;
      delegatedScope = via.scope;
    } else delegatedScope = new Set([...delegatedScope!].filter((x) => via.scope.has(x)));
    const theirs = findAuthority(principal, req);
    if (!theirs.vc) {
      throw theirs.problem ?? new Refusal('MISSING_AUTHORITY', `No authority credential in this presentation gives ${friendlyDid(principal)} (on whose behalf you act) the right to ${req.entry}.`);
    }
    explanation.push(describe(theirs.vc, req.action, principal));
  }
  if (principal) result.delegatedFor = principal;

  // Collect actions: the holder's own valid VACs, plus the principal's actions narrowed to the delegated scope.
  // Actions scoped to something other than the pod are reported as `action@<scopeDid>`.
  const actions = new Set<string>();
  let tier: Tier | undefined;
  for (const vc of vacs) {
    const subject = vc.credentialSubject?.id;
    if (subject !== holder && subject !== principal) continue;
    if (authorityProblem(vc, byDigest, podOk, ctx)) continue;
    const a = vc.credentialSubject['authority'];
    for (const act of a.actions as string[]) {
      if (subject !== holder && !delegatedScope!.has(act)) continue;
      actions.add(isPodScope(a.scope) ? act : `${act}@${a.scope}`);
    }
    const t = vc.credentialSubject['tier'];
    if (!a.parent && subject === holder && typeof t === 'string' && (TIERS as readonly string[]).includes(t)) {
      if (!tier || tierRank(t as Tier) > tierRank(tier)) tier = t as Tier;
    }
  }
  result.authorities = [...actions].sort();
  if (tier) {
    result.tier = tier;
    explanation.push(`Your authority credentials place you at tier ${tier}.`);
  }

  // ── 7. status ────────────────────────────────────────────────────────────────────────────────────
  if ((policy.statusCheck ?? 'ifPresent') === 'ifPresent') {
    let unchecked = false;
    for (const vc of creds) {
      const entries = ([] as any[]).concat(vc.credentialStatus ?? []).filter((s) => s?.type === 'BitstringStatusListEntry');
      for (const entry of entries) {
        if (!deps.statusFetch) {
          unchecked = true;
          continue;
        }
        let revoked: boolean;
        try {
          revoked = await isRevoked(entry, deps.statusFetch);
        } catch {
          throw new Refusal('UPSTREAM_UNAVAILABLE', 'The credential status list could not be checked right now, so this gate cannot decide.');
        }
        if (revoked) {
          const label = vc.type.find((t) => t !== 'VerifiableCredential') ?? 'credential';
          throw new Refusal('EXPIRED', `This ${label} was revoked by its issuer.`);
        }
      }
    }
    if (unchecked) explanation.push('Status list not checked.');
  }
}

/** Returns the pod DID when a complete, accepted membership pair is present. */
function checkMembership(creds: VerifiableCredential[], accepted: Set<string>, ctx: Ctx, required: boolean): string | undefined {
  const { holder } = ctx;
  const memberships = creds.filter((vc) => isType(vc, 'MembershipCredential'));
  const grants = memberships.filter((vc) => vc.issuer !== holder && vc.credentialSubject?.id === holder);
  const acks = memberships.filter((vc) => vc.issuer === holder);

  const fail = (code: VerifyErrorCode, message: string): undefined => {
    if (required) throw new Refusal(code, message);
    ctx.explanation.push(`${message.replace(/\.$/, '')}, but this gate does not require membership.`);
    return undefined;
  };

  if (!grants.length) {
    if (acks.length) {
      return fail('PAIR_INCOMPLETE', `You acknowledged membership of ${ctx.podName(acks[0]!.credentialSubject.id)}, but the pod's grant is missing.`);
    }
    return fail('NO_MEMBERSHIP', 'This presentation carries no membership credential.');
  }
  const acceptedGrants = grants.filter((g) => accepted.has(g.issuer));
  if (!acceptedGrants.length) {
    return fail('POD_MISMATCH', `Your membership is with ${ctx.podName(grants[0]!.issuer)}, which this gate does not accept.`);
  }
  // Prefer a grant that has an acknowledgement.
  const withAck = acceptedGrants.map((g) => ({ g, a: acks.filter((a) => a.credentialSubject?.id === g.issuer) }));
  const pick = withAck.find((x) => x.a.length) ?? withAck[0]!;
  const grant = pick.g;
  const name = ctx.podName(grant.issuer);
  if (!pick.a.length) {
    return fail('PAIR_INCOMPLETE', `The membership grant from ${name} has no acknowledgement from you, so the pair is incomplete.`);
  }
  const grantDigest = digestMultibase(grant);
  const ack = pick.a.find((a) => a.credentialSubject['digestMultibase'] === grantDigest);
  if (!ack) {
    return fail('DIGEST_MISMATCH', `Your acknowledgement does not refer to the membership grant from ${name}.`);
  }
  const core = isMembershipPairComplete(grant, ack, new Date(ctx.now));
  if (!core.ok) {
    // credential-core has no skew tolerance; re-check windows with skew before refusing.
    const w = windowProblem(grant, 'membership grant', ctx) ?? windowProblem(ack, 'membership acknowledgement', ctx);
    const noExpiry = !grant.validUntil || !ack.validUntil;
    if (w || noExpiry) {
      return fail('EXPIRED', w ?? `Your membership of ${name} has no expiry date, so it cannot be accepted.`);
    }
    if (!/valid yet|expired/.test(core.reason ?? '')) {
      return fail('PAIR_INCOMPLETE', `Membership with ${name} is incomplete: ${lowerFirst(core.reason ?? 'unknown reason')}`);
    }
    ctx.explanation.push(`Membership with ${name} is at the edge of its validity window and was accepted within the allowed clock skew.`);
  }
  ctx.explanation.push(`Membership pair with ${name} is complete.`);
  return grant.issuer;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Rebuilds group → … → holder for `action`, walking backwards from the holder. Undefined when no hop reaches the holder. */
function delegationChainFor(grants: VerifiableCredential[], action: string, ctx: Ctx): VerifiableCredential[] | undefined {
  const chain: VerifiableCredential[] = [];
  let cursor = ctx.holder;
  for (;;) {
    const hop = grants.find(
      (vc) => vc.credentialSubject?.id === cursor && !chain.includes(vc) && vc.credentialSubject['delegation'].scope.includes(action),
    );
    if (!hop) break;
    chain.unshift(hop);
    cursor = hop.issuer;
    if (chain.length > grants.length) break;
  }
  return chain.length ? chain : undefined;
}

/** Checks one delegation chain for `action`; returns its principal and the scope every hop grants. */
function checkDelegation(
  chain: VerifiableCredential[],
  acceptances: VerifiableCredential[],
  action: string,
  ctx: Ctx,
): { principal: string; scope: Set<string> } {
  const group = chain[0]!.issuer;
  // Depth first, so an over-long chain is reported as such.
  for (const [i, hop] of chain.entries()) {
    const below = chain.length - 1 - i;
    const maxDepth = Number(hop.credentialSubject['delegation']?.maxDepth ?? 0);
    if (below > maxDepth) {
      throw new Refusal(
        'CHAIN_TOO_DEEP',
        `The delegation from ${friendlyDid(group)} passes through ${chain.length} hands, but ${i === 0 ? 'the group' : `hop ${i + 1}`} allows re-delegation to depth ${maxDepth} only.`,
      );
    }
  }
  const r = checkDelegationChain(chain, { actor: ctx.holder, requiredScope: action, acceptances, now: new Date(ctx.now) });
  if (!r.ok) {
    const reason = r.reason ?? '';
    const code: VerifyErrorCode = /depth|deeper/.test(reason) ? 'CHAIN_TOO_DEEP' : /expired|not valid yet/.test(reason) ? 'EXPIRED' : 'MISSING_AUTHORITY';
    throw new Refusal(code, `The delegation from ${friendlyDid(group)} does not let you ${action}: ${lowerFirst(reason || 'unknown reason')}`);
  }
  let scope = new Set<string>(chain[0]!.credentialSubject['delegation'].scope as string[]);
  for (const hop of chain.slice(1)) {
    const hs = hop.credentialSubject['delegation'].scope as string[];
    scope = new Set([...scope].filter((x) => hs.includes(x)));
  }
  const line = `You act for ${friendlyDid(group)} through a delegation of ${chain.length} hop${chain.length === 1 ? '' : 's'}.`;
  if (!ctx.explanation.includes(line)) ctx.explanation.push(line);
  return { principal: group, scope };
}

/**
 * Checks one VAC: every link's validity window (with skew), the attenuation chain back to its root
 * (parents presented; structural rules via credential-core `checkAuthorityChain`), and the root issued by the pod.
 */
function authorityProblem(
  vc: VerifiableCredential,
  byDigest: Map<string, VerifiableCredential>,
  podOk: (issuer: string) => boolean,
  ctx: Ctx,
): Refusal | undefined {
  // Rebuild the chain leaf → root by following `authority.parent` digests.
  const chain: VerifiableCredential[] = [vc];
  for (;;) {
    const a = chain[0]!.credentialSubject?.['authority'];
    if (!a || !Array.isArray(a.actions)) return new Refusal('MISSING_AUTHORITY', 'An authority credential has no authority claim.');
    if (!a.parent) break;
    const parent = byDigest.get(a.parent);
    if (!parent) return new Refusal('BROADENED_ATTENUATION', 'This passed-on authority credential cannot be checked because its parent was not presented.');
    if (chain.includes(parent) || chain.length > MAX_ATTENUATION_HOPS) {
      return new Refusal('CHAIN_TOO_DEEP', 'This authority has been passed on too many times.');
    }
    chain.unshift(parent);
  }
  for (const link of chain) {
    const w = windowProblem(link, 'authority credential', ctx);
    if (w) return new Refusal('EXPIRED', w);
    if (!link.validUntil) return new Refusal('EXPIRED', 'This authority credential has no expiry date, so it cannot be accepted.');
  }
  if (chain.length > 1) {
    const r = checkAuthorityChain(chain);
    if (!r.ok) {
      const reason = lowerFirst(r.reason ?? 'unknown reason').replace(/\.$/, '');
      return /depth/i.test(reason)
        ? new Refusal('CHAIN_TOO_DEEP', `This authority has been passed on further than allowed (${reason}).`)
        : new Refusal('BROADENED_ATTENUATION', `This passed-on authority goes beyond its parent (${reason}), so it was refused.`);
    }
  }
  const root = chain[0]!;
  if (!podOk(root.issuer)) {
    return new Refusal('POD_MISMATCH', `This authority credential was issued by ${friendlyDid(root.issuer)}, not by a pod this gate accepts.`);
  }
  return undefined;
}
