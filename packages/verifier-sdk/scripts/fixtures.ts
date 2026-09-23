/**
 * Deterministic fixtures shared by `gen-vectors.ts` and the unit tests. Fixed seeds, fixed dates, fixed nonces:
 * Ed25519 signatures are deterministic, so regenerating produces byte-identical vectors.
 */
import {
  attenuate,
  buildAuthority,
  buildDelegation,
  buildDelegationAcceptance,
  buildEndorsement,
  buildMembershipAck,
  buildMembershipGrant,
  CONTEXTS,
  digestMultibase,
  didWebDocument,
  keyPairForDid,
  keyPairFromSeed,
  signDocument,
  type DidDocument,
  type KeyPair,
  type VerifiableCredential,
  type VerifiablePresentation,
} from '@passport/credential-core';
import { tierDefaultActions } from '@passport/vocab';

export const NOW = '2026-10-01T00:00:00Z';
export const FROM = '2026-09-20T00:00:00Z';
/** 86 days after FROM: within the 90-day ceiling for memberships and pod VACs. */
export const UNTIL = '2026-12-15T00:00:00Z';
/** 20 days after FROM: within the 30-day ceiling for attenuated VACs. */
export const STAFF_UNTIL = '2026-10-10T00:00:00Z';
export const CHALLENGE = 'conformance-challenge-0001';
export const DOMAIN = 'bioregionalpassport.org';

const seed = (n: number) => new Uint8Array(32).fill(n);
const web = (slug: string) => `did:web:bioregionalpassport.org:dids:${slug}`;

export const BOULDER = web('boulder');
export const TENANT_ZERO = web('tenant-zero');
export const GARDEN_GROUP = web('garden-collective');
export const ENTERPRISE = web('moxie-bread');

export const keys = {
  boulder: keyPairForDid(BOULDER, seed(1)),
  tenantZero: keyPairForDid(TENANT_ZERO, seed(2)),
  group: keyPairForDid(GARDEN_GROUP, seed(3)),
  alice: keyPairFromSeed(seed(11)),
  bob: keyPairFromSeed(seed(12)),
  carol: keyPairFromSeed(seed(13)),
};

export const staticDids: Record<string, DidDocument> = Object.fromEntries(
  [keys.boulder, keys.tenantZero, keys.group].map((k) => [k.did, didWebDocument(k.did, k.publicKeyMultibase)]),
);

export const sign = (vc: VerifiableCredential, key: KeyPair): VerifiableCredential => signDocument(vc, key, { created: FROM });

export function present(creds: VerifiableCredential[], holder: KeyPair, opts: { challenge?: string; domain?: string } = {}): VerifiablePresentation {
  const vp: VerifiablePresentation = {
    '@context': [...CONTEXTS],
    type: ['VerifiablePresentation'],
    holder: holder.did,
    verifiableCredential: creds,
  };
  return signDocument(vp, holder, {
    proofPurpose: 'authentication',
    challenge: opts.challenge ?? CHALLENGE,
    domain: opts.domain ?? DOMAIN,
    created: NOW,
  });
}

export function grant(pod: KeyPair, member: KeyPair, nonce = 'bm9uY2Utbm9uY2Utbm9uY2U'): VerifiableCredential {
  return sign(
    buildMembershipGrant({
      pod: pod.did,
      member: member.did,
      bioregion: pod.did.split(':').pop()!,
      placeIds: ['huc12:101900050101'],
      governance: `https://bioregionalpassport.org/p/${pod.did.split(':').pop()}/governance`,
      validFrom: FROM,
      validUntil: UNTIL,
      nonce,
    }),
    pod,
  );
}

export function ack(member: KeyPair, pod: KeyPair, grantDigest: string): VerifiableCredential {
  return sign(buildMembershipAck({ member: member.did, pod: pod.did, grantDigest, validFrom: FROM, validUntil: UNTIL }), member);
}

export function membershipPair(pod: KeyPair, member: KeyPair): VerifiableCredential[] {
  const g = grant(pod, member);
  return [g, ack(member, pod, digestMultibase(g))];
}

export function vac(
  pod: KeyPair,
  subject: string,
  actions: string[],
  opts: { scope?: string; tier?: string; validFrom?: string; validUntil?: string } = {},
): VerifiableCredential {
  return sign(
    buildAuthority({
      issuer: pod.did,
      subject,
      scope: opts.scope ?? pod.did,
      actions,
      validFrom: opts.validFrom ?? FROM,
      validUntil: opts.validUntil ?? UNTIL,
      policyVersion: 1,
      ...(opts.tier ? { tier: opts.tier } : {}),
    }),
    pod,
  );
}

export const T1_ACTIONS: string[] = [...tierDefaultActions('T1')];

/** Group → steward delegation plus the steward's acceptance. */
export function delegationHop(from: KeyPair, to: KeyPair, scope: string[], maxDepth = 0): VerifiableCredential[] {
  const g = sign(buildDelegation({ group: from.did, steward: to.did, scope, maxDepth, validFrom: FROM, validUntil: UNTIL }), from);
  const a = sign(buildDelegationAcceptance({ steward: to.did, group: from.did, grantDigest: digestMultibase(g), validFrom: FROM, validUntil: UNTIL, scope }), to);
  return [g, a];
}

/** Owner pay:receive VAC for the enterprise, attenuated (properly) to staff. */
export function payReceiveChain(owner: KeyPair, staff: KeyPair): { root: VerifiableCredential; child: VerifiableCredential } {
  const root = vac(keys.boulder, owner.did, ['pay:receive'], { scope: ENTERPRISE });
  const child = sign(attenuate(root, { issuerKey: owner, subject: staff.did, actions: ['pay:receive'], validFrom: FROM, validUntil: STAFF_UNTIL }), owner);
  return { root, child };
}

/** A hand-built attenuation that grants more than its parent (attenuate() would refuse it). */
export function broadenedChain(owner: KeyPair, staff: KeyPair): { root: VerifiableCredential; child: VerifiableCredential } {
  const root = vac(keys.boulder, owner.did, ['pay:receive'], { scope: ENTERPRISE });
  const child = sign(
    buildAuthority({
      issuer: owner.did,
      subject: staff.did,
      scope: ENTERPRISE,
      actions: ['pay:receive', 'credit:account'],
      parent: digestMultibase(root),
      depth: 1,
      validFrom: FROM,
      validUntil: STAFF_UNTIL,
      bioregionScope: 'directed',
    }),
    owner,
  );
  return { root, child };
}

/** A StatementCredential with an arbitrary predicate (e.g. one outside the vocabulary). */
export function statement(issuer: KeyPair, subject: KeyPair, predicate: string): VerifiableCredential {
  const vc = buildEndorsement({ issuer: issuer.did, subject: subject.did, scope: 'knows', validFrom: FROM });
  vc.credentialSubject['predicate'] = predicate;
  return sign(vc, issuer);
}

export function endorsement(issuer: KeyPair, subject: KeyPair): VerifiableCredential {
  return sign(buildEndorsement({ issuer: issuer.did, subject: subject.did, scope: 'knows', validFrom: FROM }), issuer);
}
