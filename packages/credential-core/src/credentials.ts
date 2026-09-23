import { digestMultibase, randomNonce } from './encoding.js';
import type { DidScope, KeyPair } from './keys.js';
import { signDocument, type DataIntegrityProof } from './proof.js';

/** B3 §2 credential @context, in order. */
export const CONTEXTS: string[] = [
  'https://www.w3.org/ns/credentials/v2',
  'https://firstperson.network/credentials/dtg/v1',
  'https://bioregion.org/credentials/v1',
];

export type DtgType =
  | 'MembershipCredential'
  | 'InvitationCredential'
  | 'RelationshipCredential'
  | 'StatementCredential'
  | 'DelegationCredential'
  | 'AuthorityCredential'
  | 'PersonaCredential';

export interface VerifiableCredential {
  '@context': string[];
  type: string[];
  issuer: string;
  validFrom: string;
  validUntil?: string;
  credentialSubject: Record<string, any> & { id: string; bioregionScope?: DidScope };
  credentialStatus?: any;
  proof?: DataIntegrityProof;
}

export interface VerifiablePresentation {
  '@context': string[];
  type: ['VerifiablePresentation'];
  holder: string;
  verifiableCredential: VerifiableCredential[];
  proof?: DataIntegrityProof;
}

const DAY_MS = 86_400_000;
/** B3 §2 validity ceilings. */
export const MAX_VALIDITY_DAYS = { membership: 90, invitation: 30, attenuatedAuthority: 30 } as const;

/** Common optional inputs on every builder. `bioregionScope` overrides the builder's default declared scope. */
export interface BuilderCommon {
  validFrom?: string;
  bioregionScope?: DidScope;
}

function iso(s: string, field: string): number {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`${field} is not a valid ISO date: ${s}`);
  return t;
}

function base(
  type: DtgType,
  issuer: string,
  subject: Record<string, any> & { id: string },
  scope: DidScope,
  p: BuilderCommon & { validUntil?: string },
  maxDays?: number,
): VerifiableCredential {
  if (!issuer) throw new Error('issuer is required.');
  if (!subject.id) throw new Error('credentialSubject.id is required.');
  const validFrom = p.validFrom ?? new Date().toISOString();
  const from = iso(validFrom, 'validFrom');
  const vc: VerifiableCredential = {
    '@context': [...CONTEXTS],
    type: ['VerifiableCredential', type],
    issuer,
    validFrom,
    credentialSubject: { ...subject, bioregionScope: p.bioregionScope ?? scope },
  };
  if (p.validUntil !== undefined) {
    const until = iso(p.validUntil, 'validUntil');
    if (until <= from) throw new Error('validUntil must be after validFrom.');
    if (maxDays !== undefined && until - from > maxDays * DAY_MS) {
      throw new Error(`${type} may be valid for at most ${maxDays} days.`);
    }
    vc.validUntil = p.validUntil;
  }
  return vc;
}

/** Drop keys whose value is undefined so optional claims are absent rather than `undefined`. */
function compact<T extends Record<string, any>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// Default declared scopes (issuer's identifier scope, B3 §1): pods/groups are public, personas are directed,
// person↔person relationship identifiers are pairwise.

/** MembershipCredential grant: pod/group → member. ≤ 90 days. */
export function buildMembershipGrant(p: BuilderCommon & { pod: string; member: string; bioregion: string; placeIds: string[]; governance: string; validUntil: string; nonce?: string }): VerifiableCredential {
  return base('MembershipCredential', p.pod, {
    id: p.member,
    bioregion: p.bioregion,
    placeIds: [...p.placeIds],
    nonce: p.nonce ?? randomNonce(16),
    governance: p.governance,
  }, 'public', p, MAX_VALIDITY_DAYS.membership);
}

/** MembershipCredential ack: member → pod/group, carrying the grant's digest. ≤ 90 days. */
export function buildMembershipAck(p: BuilderCommon & { member: string; pod: string; grantDigest: string; validUntil: string }): VerifiableCredential {
  return base('MembershipCredential', p.member, { id: p.pod, digestMultibase: p.grantDigest }, 'directed', p, MAX_VALIDITY_DAYS.membership);
}

/** InvitationCredential: member/pod → prospect. ≤ 30 days. */
export function buildInvitation(p: BuilderCommon & { issuer: string; prospect: string; bioregion: string; event?: string; validUntil: string }): VerifiableCredential {
  return base('InvitationCredential', p.issuer, compact({ id: p.prospect, bioregion: p.bioregion, event: p.event }), 'directed', p, MAX_VALIDITY_DAYS.invitation);
}

/** RelationshipCredential: person ↔ person (pairwise). No expiry. */
export function buildRelationship(p: BuilderCommon & { issuer: string; subject: string; bioregion: string; placeId?: string; formedAt: string }): VerifiableCredential {
  iso(p.formedAt, 'formedAt');
  return base('RelationshipCredential', p.issuer, compact({ id: p.subject, bioregion: p.bioregion, placeId: p.placeId, formedAt: p.formedAt }), 'pairwise', p);
}

export const ENDORSEMENT_SCOPES = ['lives-here', 'worked-with', 'knows'] as const;

/** StatementCredential `dtg:endorses`: person → person. No expiry (age-decayed by the index). */
export function buildEndorsement(p: BuilderCommon & { issuer: string; subject: string; scope: 'lives-here' | 'worked-with' | 'knows' }): VerifiableCredential {
  if (!ENDORSEMENT_SCOPES.includes(p.scope)) throw new Error(`Endorsement scope must be one of ${ENDORSEMENT_SCOPES.join(', ')}.`);
  return base('StatementCredential', p.issuer, {
    id: p.subject,
    predicate: 'dtg:endorses',
    object: { id: p.subject, value: { scope: p.scope } },
  }, 'directed', p);
}

/**
 * StatementCredential `dtg:witnessed`: convener/pod VTA → edge credential.
 * Without an explicit `subject`, `credentialSubject.id` is `urn:digest:<edgeDigest>`.
 */
export function buildWitness(p: BuilderCommon & { issuer: string; edgeDigest: string; taskContext: string; taskDigest: string; evidence: 'same-event' | 'liveness'; validUntil: string; subject?: string }): VerifiableCredential {
  if (p.evidence !== 'same-event' && p.evidence !== 'liveness') throw new Error('Witness evidence must be same-event or liveness.');
  return base('StatementCredential', p.issuer, {
    id: p.subject ?? `urn:digest:${p.edgeDigest}`,
    predicate: 'dtg:witnessed',
    object: { digestMultibase: p.edgeDigest },
    taskContext: p.taskContext,
    taskDigestMultibase: p.taskDigest,
    evidence: p.evidence,
  }, 'directed', p);
}

/** DelegationCredential: group → steward. `maxDepth` defaults to 0; `accepts` is set once the steward accepted. */
export function buildDelegation(p: BuilderCommon & { group: string; steward: string; scope: string[]; maxDepth?: number; validUntil: string; accepts?: string }): VerifiableCredential {
  if (!p.scope.length) throw new Error('Delegation needs at least one scope.');
  const maxDepth = p.maxDepth ?? 0;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new Error('maxDepth must be a non-negative integer.');
  return base('DelegationCredential', p.group, {
    id: p.steward,
    delegation: compact({ scope: [...p.scope], maxDepth, accepts: p.accepts }),
  }, 'public', p);
}

/**
 * AuthorityCredential (VAC): pod PEP / owner → member/staff.
 * `depth`/`maxDepth` are attenuation bookkeeping (see `attenuate`); they are omitted on a plain root VAC.
 */
export function buildAuthority(p: BuilderCommon & { issuer: string; subject: string; scope: string; actions: string[]; validUntil: string; parent?: string; tier?: string; policyVersion?: number; depth?: number; maxDepth?: number }): VerifiableCredential {
  if (!p.scope) throw new Error('authority.scope is required.');
  if (!p.actions.length) throw new Error('authority.actions must not be empty.');
  return base('AuthorityCredential', p.issuer, compact({
    id: p.subject,
    authority: compact({ scope: p.scope, actions: [...p.actions], parent: p.parent, depth: p.depth, maxDepth: p.maxDepth }),
    tier: p.tier,
    policyVersion: p.policyVersion,
  }), 'public', p);
}

/** PersonaCredential: directed persona → public DID (did:plc). No expiry. */
export function buildPersonaLink(p: BuilderCommon & { persona: string; publicDid: string }): VerifiableCredential {
  return base('PersonaCredential', p.persona, { id: p.publicDid }, 'directed', p);
}

/** StatementCredential `bioregion:adjudicated`: steward → subject about a disputed credential. */
export function buildAdjudication(p: BuilderCommon & { steward: string; subject: string; disputedDigest: string; outcome: string; validUntil: string }): VerifiableCredential {
  return base('StatementCredential', p.steward, {
    id: p.subject,
    predicate: 'bioregion:adjudicated',
    object: { digestMultibase: p.disputedDigest },
    outcome: p.outcome,
  }, 'directed', p);
}

const hasType = (vc: VerifiableCredential, t: DtgType) => Array.isArray(vc?.type) && vc.type.includes('VerifiableCredential') && vc.type.includes(t);

/** Default attenuation allowance when the root VAC does not set `authority.maxDepth`. */
export const DEFAULT_AUTHORITY_MAX_DEPTH = 1;

/**
 * Attenuate a signed AuthorityCredential to a new subject (e.g. owner → staff for `pay:receive`).
 *
 * Rules:
 * - `issuerKey.did` must be the parent's subject (only the holder can attenuate);
 * - `actions` must be a non-empty subset of the parent's actions; `authority.scope` is copied;
 * - `validUntil` must not exceed the parent's, and at most 30 days from validFrom (B3 §2);
 * - depth: the root VAC has depth 0 (absent). Each attenuation sets `authority.depth = parentDepth + 1` and
 *   carries forward `authority.maxDepth`. Allowed iff `parentDepth + 1 ≤ maxDepth`, where maxDepth comes from
 *   the root (copied down the chain) and defaults to 1: a root VAC may be attenuated once (to staff); that
 *   attenuated VAC may not be attenuated again unless the root set a larger `authority.maxDepth`.
 *   (DelegationCredential's `maxDepth` defaults to 0 per B3; this is a separate AuthorityCredential rule.)
 * - `authority.parent = digestMultibase(parent)` (digest over the credential including its proof).
 */
export function attenuate(parent: VerifiableCredential, p: { issuerKey: KeyPair; subject: string; actions: string[]; validUntil: string; validFrom?: string }): VerifiableCredential {
  if (!hasType(parent, 'AuthorityCredential')) throw new Error('Only an AuthorityCredential can be attenuated.');
  if (!parent.proof) throw new Error('The parent AuthorityCredential must be signed before it can be attenuated.');
  const auth = parent.credentialSubject['authority'] as { scope: string; actions: string[]; depth?: number; maxDepth?: number } | undefined;
  if (!auth || !Array.isArray(auth.actions)) throw new Error('Parent credential has no authority claim.');
  if (p.issuerKey.did !== parent.credentialSubject.id) throw new Error('Only the subject of the parent authority can attenuate it.');
  if (!p.actions.length) throw new Error('An attenuated authority needs at least one action.');
  const extra = p.actions.filter((a) => !auth.actions.includes(a));
  if (extra.length) throw new Error(`Cannot grant actions the parent does not hold: ${extra.join(', ')}.`);
  if (!parent.validUntil) throw new Error('Parent authority has no validUntil.');
  if (iso(p.validUntil, 'validUntil') > iso(parent.validUntil, 'parent validUntil')) {
    throw new Error('An attenuated authority cannot outlive its parent.');
  }
  if (iso(parent.validUntil, 'parent validUntil') <= Date.now()) throw new Error('The parent authority has expired.');
  const parentDepth = auth.depth ?? 0;
  const maxDepth = auth.maxDepth ?? DEFAULT_AUTHORITY_MAX_DEPTH;
  if (parentDepth + 1 > maxDepth) throw new Error(`This authority cannot be attenuated further (max depth ${maxDepth}).`);
  const child = buildAuthority({
    issuer: p.issuerKey.did,
    subject: p.subject,
    scope: auth.scope,
    actions: p.actions,
    validUntil: p.validUntil,
    parent: digestMultibase(parent),
    depth: parentDepth + 1,
    maxDepth: auth.maxDepth,
    policyVersion: parent.credentialSubject['policyVersion'],
    bioregionScope: 'directed',
    ...(p.validFrom !== undefined ? { validFrom: p.validFrom } : {}),
  });
  const span = iso(child.validUntil!, 'validUntil') - iso(child.validFrom, 'validFrom');
  if (span > MAX_VALIDITY_DAYS.attenuatedAuthority * DAY_MS) {
    throw new Error(`An attenuated authority may be valid for at most ${MAX_VALIDITY_DAYS.attenuatedAuthority} days.`);
  }
  return child;
}

function currentlyValid(vc: VerifiableCredential, now: number, label: string): string | undefined {
  if (Date.parse(vc.validFrom) > now) return `The ${label} is not valid yet.`;
  if (!vc.validUntil) return `The ${label} has no expiry date.`;
  if (Date.parse(vc.validUntil) <= now) return `The ${label} has expired.`;
  return undefined;
}

/**
 * A membership is complete when the member's ack carries the digest of the pod's grant, the parties are
 * mirrored (grant pod→member, ack member→pod), and both are within their validity windows.
 */
export function isMembershipPairComplete(grant: VerifiableCredential, ack: VerifiableCredential, now: Date = new Date()): { ok: boolean; reason?: string } {
  if (!hasType(grant, 'MembershipCredential') || !hasType(ack, 'MembershipCredential')) {
    return { ok: false, reason: 'Both halves must be MembershipCredentials.' };
  }
  if (ack.credentialSubject['digestMultibase'] !== digestMultibase(grant)) {
    return { ok: false, reason: 'The acknowledgement does not refer to this membership grant.' };
  }
  if (ack.issuer !== grant.credentialSubject.id || ack.credentialSubject.id !== grant.issuer) {
    return { ok: false, reason: 'The acknowledgement is not from the granted member back to the granting pod.' };
  }
  const t = now.getTime();
  const r = currentlyValid(grant, t, 'membership grant') ?? currentlyValid(ack, t, 'membership acknowledgement');
  return r ? { ok: false, reason: r } : { ok: true };
}

/** Holder-signed VerifiablePresentation bound to a verifier challenge and domain (proofPurpose `authentication`). */
export function createPresentation(creds: VerifiableCredential[], holderKey: KeyPair, opts: { challenge: string; domain: string }): VerifiablePresentation {
  if (!opts.challenge || !opts.domain) throw new Error('A presentation needs a challenge and a domain.');
  const vp: VerifiablePresentation = {
    '@context': [...CONTEXTS],
    type: ['VerifiablePresentation'],
    holder: holderKey.did,
    verifiableCredential: creds,
  };
  return signDocument(vp, holderKey, { proofPurpose: 'authentication', challenge: opts.challenge, domain: opts.domain });
}

/**
 * STRUCTURAL check of a delegation chain group → steward → … → actor. It does NOT verify proofs:
 * the caller (verifier SDK) must verify every hop's signature separately.
 *
 * Checks: every hop is a DelegationCredential; chain[0].issuer is the principal; each hop's subject is the next
 * hop's issuer; the last subject is `actor`; every hop records acceptance (`delegation.accepts`) and includes
 * `requiredScope`; hop i allows the remaining hops beneath it (`hops - 1 - i ≤ delegation.maxDepth`, default 0,
 * so for the root: hops − 1 ≤ maxDepth); every hop is within its validity window.
 */
export function checkDelegationChain(chain: VerifiableCredential[], p: { actor: string; requiredScope: string; now?: Date }): { ok: boolean; principal?: string; reason?: string } {
  if (!Array.isArray(chain) || chain.length === 0) return { ok: false, reason: 'The delegation chain is empty.' };
  const now = (p.now ?? new Date()).getTime();
  const principal = chain[0]!.issuer;
  for (let i = 0; i < chain.length; i++) {
    const hop = chain[i]!;
    const n = i + 1;
    if (!hasType(hop, 'DelegationCredential')) return { ok: false, reason: `Hop ${n} is not a DelegationCredential.` };
    const d = hop.credentialSubject['delegation'] as { scope?: string[]; maxDepth?: number; accepts?: string } | undefined;
    if (!d || !Array.isArray(d.scope)) return { ok: false, reason: `Hop ${n} has no delegation claim.` };
    if (!d.accepts) return { ok: false, reason: `Hop ${n} was never accepted by its steward.` };
    if (!d.scope.includes(p.requiredScope)) return { ok: false, reason: `Hop ${n} does not delegate ${p.requiredScope}.` };
    const below = chain.length - 1 - i;
    if (below > (d.maxDepth ?? 0)) return { ok: false, reason: `Hop ${n} allows re-delegation to depth ${d.maxDepth ?? 0}, but the chain goes ${below} deeper.` };
    const next = chain[i + 1];
    if (next && next.issuer !== hop.credentialSubject.id) return { ok: false, reason: `Hop ${n + 1} was not issued by the steward named in hop ${n}.` };
    const v = currentlyValid(hop, now, `delegation at hop ${n}`);
    if (v) return { ok: false, reason: v };
  }
  if (chain[chain.length - 1]!.credentialSubject.id !== p.actor) return { ok: false, reason: 'The chain does not end at the acting person.' };
  return { ok: true, principal };
}
