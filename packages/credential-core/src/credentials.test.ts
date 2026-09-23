import { describe, expect, it } from 'vitest';
import {
  CONTEXTS,
  attenuate,
  buildAdjudication,
  buildAuthority,
  buildDelegation,
  buildEndorsement,
  buildInvitation,
  buildMembershipAck,
  buildMembershipGrant,
  buildPersonaLink,
  buildRelationship,
  buildWitness,
  checkDelegationChain,
  createResolver,
  digestMultibase,
  didWebDocument,
  didWebFromDomainPath,
  fromBase64url,
  generateKeyPair,
  isMembershipPairComplete,
  keyPairForDid,
  signDocument,
  verifyDocument,
  type VerifiableCredential,
} from './index.js';

const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();

const podDid = didWebFromDomainPath('bioregionalpassport.org', 'dids', 'boulder');
const podKey = keyPairForDid(podDid, generateKeyPair().privateKey);
const resolver = createResolver({ staticDocs: { [podDid]: didWebDocument(podDid, podKey.publicKeyMultibase) } });
const alice = generateKeyPair();
const bob = generateKeyPair();

function expectBaseShape(vc: VerifiableCredential, type: string, issuer: string, subject: string) {
  expect(vc['@context']).toEqual(CONTEXTS);
  expect(CONTEXTS).toEqual([
    'https://www.w3.org/ns/credentials/v2',
    'https://firstperson.network/credentials/dtg/v1',
    'https://bioregion.org/credentials/v1',
  ]);
  expect(vc.type).toEqual(['VerifiableCredential', type]);
  expect(vc.issuer).toBe(issuer);
  expect(vc.credentialSubject.id).toBe(subject);
  expect(Number.isNaN(Date.parse(vc.validFrom))).toBe(false);
  expect(['public', 'directed', 'pairwise']).toContain(vc.credentialSubject.bioregionScope);
  expect(vc.proof).toBeUndefined();
}

describe('builders (B3 §2 required claims)', () => {
  it('membership grant', () => {
    const vc = buildMembershipGrant({ pod: podDid, member: alice.did, bioregion: 'boulder', placeIds: ['huc12:101900050101'], governance: 'https://boulder.example/gov', validUntil: inDays(90) });
    expectBaseShape(vc, 'MembershipCredential', podDid, alice.did);
    expect(vc.credentialSubject).toMatchObject({ bioregion: 'boulder', placeIds: ['huc12:101900050101'], governance: 'https://boulder.example/gov', bioregionScope: 'public' });
    expect(fromBase64url(vc.credentialSubject['nonce']).length).toBeGreaterThanOrEqual(16);
    expect(buildMembershipGrant({ pod: podDid, member: alice.did, bioregion: 'b', placeIds: [], governance: 'g', validUntil: inDays(1), nonce: 'n1' }).credentialSubject['nonce']).toBe('n1');
    expect(() => buildMembershipGrant({ pod: podDid, member: alice.did, bioregion: 'b', placeIds: [], governance: 'g', validUntil: inDays(91) })).toThrow(/90 days/);
  });

  it('membership ack', () => {
    const vc = buildMembershipAck({ member: alice.did, pod: podDid, grantDigest: 'zQmX', validUntil: inDays(90) });
    expectBaseShape(vc, 'MembershipCredential', alice.did, podDid);
    expect(vc.credentialSubject['digestMultibase']).toBe('zQmX');
  });

  it('invitation', () => {
    const vc = buildInvitation({ issuer: alice.did, prospect: bob.did, bioregion: 'boulder', event: 'evt-1', validUntil: inDays(30) });
    expectBaseShape(vc, 'InvitationCredential', alice.did, bob.did);
    expect(vc.credentialSubject).toMatchObject({ bioregion: 'boulder', event: 'evt-1' });
    expect('event' in buildInvitation({ issuer: alice.did, prospect: bob.did, bioregion: 'b', validUntil: inDays(1) }).credentialSubject).toBe(false);
    expect(() => buildInvitation({ issuer: alice.did, prospect: bob.did, bioregion: 'b', validUntil: inDays(31) })).toThrow(/30 days/);
  });

  it('relationship', () => {
    const vc = buildRelationship({ issuer: alice.did, subject: bob.did, bioregion: 'boulder', placeId: 'huc12:1', formedAt: '2026-09-22T10:00:00Z' });
    expectBaseShape(vc, 'RelationshipCredential', alice.did, bob.did);
    expect(vc.credentialSubject).toMatchObject({ bioregion: 'boulder', placeId: 'huc12:1', formedAt: '2026-09-22T10:00:00Z', bioregionScope: 'pairwise' });
    expect(vc.validUntil).toBeUndefined();
  });

  it('endorsement (dtg:endorses)', () => {
    const vc = buildEndorsement({ issuer: alice.did, subject: bob.did, scope: 'lives-here' });
    expectBaseShape(vc, 'StatementCredential', alice.did, bob.did);
    expect(vc.credentialSubject['predicate']).toBe('dtg:endorses');
    expect(vc.credentialSubject['object']).toEqual({ id: bob.did, value: { scope: 'lives-here' } });
    expect(() => buildEndorsement({ issuer: alice.did, subject: bob.did, scope: 'nope' as any })).toThrow();
  });

  it('witness (dtg:witnessed)', () => {
    const vc = buildWitness({ issuer: podDid, edgeDigest: 'zQmEdge', taskContext: 'evt-1', taskDigest: 'zQmTask', evidence: 'same-event', validUntil: inDays(365) });
    expectBaseShape(vc, 'StatementCredential', podDid, 'urn:digest:zQmEdge');
    expect(vc.credentialSubject).toMatchObject({ predicate: 'dtg:witnessed', object: { digestMultibase: 'zQmEdge' }, taskContext: 'evt-1', taskDigestMultibase: 'zQmTask', evidence: 'same-event' });
    expect(buildWitness({ issuer: podDid, edgeDigest: 'e', taskContext: 't', taskDigest: 'd', evidence: 'liveness', validUntil: inDays(1), subject: bob.did }).credentialSubject.id).toBe(bob.did);
  });

  it('delegation', () => {
    const vc = buildDelegation({ group: podDid, steward: alice.did, scope: ['round:vote'], validUntil: inDays(30) });
    expectBaseShape(vc, 'DelegationCredential', podDid, alice.did);
    expect(vc.credentialSubject['delegation']).toEqual({ scope: ['round:vote'], maxDepth: 0 });
    expect(buildDelegation({ group: podDid, steward: alice.did, scope: ['x'], validUntil: inDays(1), maxDepth: 2, accepts: 'zQmG' }).credentialSubject['delegation']).toEqual({ scope: ['x'], maxDepth: 2, accepts: 'zQmG' });
  });

  it('authority', () => {
    const vc = buildAuthority({ issuer: podDid, subject: alice.did, scope: podDid, actions: ['event:attend', 'vrc:exchange'], validUntil: inDays(90), tier: 'T1', policyVersion: 3 });
    expectBaseShape(vc, 'AuthorityCredential', podDid, alice.did);
    expect(vc.credentialSubject['authority']).toEqual({ scope: podDid, actions: ['event:attend', 'vrc:exchange'] });
    expect(vc.credentialSubject).toMatchObject({ tier: 'T1', policyVersion: 3 });
  });

  it('persona link and adjudication', () => {
    const p = buildPersonaLink({ persona: alice.did, publicDid: 'did:plc:abc' });
    expectBaseShape(p, 'PersonaCredential', alice.did, 'did:plc:abc');
    const a = buildAdjudication({ steward: alice.did, subject: bob.did, disputedDigest: 'zQmD', outcome: 'upheld', validUntil: inDays(365) });
    expectBaseShape(a, 'StatementCredential', alice.did, bob.did);
    expect(a.credentialSubject).toMatchObject({ predicate: 'bioregion:adjudicated', object: { digestMultibase: 'zQmD' }, outcome: 'upheld' });
  });

  it('honours validFrom and bioregionScope overrides', () => {
    const vc = buildEndorsement({ issuer: alice.did, subject: bob.did, scope: 'knows', validFrom: '2026-01-01T00:00:00Z', bioregionScope: 'pairwise' });
    expect(vc.validFrom).toBe('2026-01-01T00:00:00Z');
    expect(vc.credentialSubject.bioregionScope).toBe('pairwise');
  });

  it('signed builders verify', async () => {
    const grant = signDocument(buildMembershipGrant({ pod: podDid, member: alice.did, bioregion: 'boulder', placeIds: ['p'], governance: 'g', validUntil: inDays(90) }), podKey);
    expect(await verifyDocument(grant, resolver)).toEqual({ ok: true, controller: podDid });
  });
});

describe('membership pair', () => {
  const grant = signDocument(buildMembershipGrant({ pod: podDid, member: alice.did, bioregion: 'boulder', placeIds: ['p'], governance: 'g', validUntil: inDays(90) }), podKey);
  const ack = signDocument(buildMembershipAck({ member: alice.did, pod: podDid, grantDigest: digestMultibase(grant), validUntil: inDays(90) }), alice);

  it('is complete when digest and parties match', () => {
    expect(isMembershipPairComplete(grant, ack)).toEqual({ ok: true });
  });

  it('fails on wrong digest, unmirrored parties, or expiry', () => {
    const wrong = signDocument(buildMembershipAck({ member: alice.did, pod: podDid, grantDigest: 'zQmNope', validUntil: inDays(90) }), alice);
    expect(isMembershipPairComplete(grant, wrong).ok).toBe(false);
    const fromBob = signDocument(buildMembershipAck({ member: bob.did, pod: podDid, grantDigest: digestMultibase(grant), validUntil: inDays(90) }), bob);
    expect(isMembershipPairComplete(grant, fromBob).ok).toBe(false);
    const r = isMembershipPairComplete(grant, ack, new Date(Date.now() + 91 * DAY));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired/);
  });
});

describe('attenuation', () => {
  const owner = generateKeyPair();
  const staff = generateKeyPair();
  const enterprise = 'did:web:bioregionalpassport.org:enterprises:bakery';
  const root = signDocument(buildAuthority({ issuer: podDid, subject: owner.did, scope: enterprise, actions: ['pay:receive', 'pay:refund'], validUntil: inDays(90), policyVersion: 2 }), podKey);

  it('produces a narrowed child linked to the parent', () => {
    const child = attenuate(root, { issuerKey: owner, subject: staff.did, actions: ['pay:receive'], validUntil: inDays(30) });
    expect(child.issuer).toBe(owner.did);
    expect(child.credentialSubject.id).toBe(staff.did);
    expect(child.credentialSubject['authority']).toEqual({ scope: enterprise, actions: ['pay:receive'], parent: digestMultibase(root), depth: 1 });
    expect(child.credentialSubject['policyVersion']).toBe(2);
  });

  it('refuses actions outside the parent', () => {
    expect(() => attenuate(root, { issuerKey: owner, subject: staff.did, actions: ['pay:receive', 'credit:account'], validUntil: inDays(30) })).toThrow(/does not hold/);
  });

  it('refuses outliving the parent or exceeding 30 days', () => {
    const shortRoot = signDocument(buildAuthority({ issuer: podDid, subject: owner.did, scope: enterprise, actions: ['pay:receive'], validUntil: inDays(10) }), podKey);
    expect(() => attenuate(shortRoot, { issuerKey: owner, subject: staff.did, actions: ['pay:receive'], validUntil: inDays(11) })).toThrow(/outlive/);
    expect(() => attenuate(root, { issuerKey: owner, subject: staff.did, actions: ['pay:receive'], validUntil: inDays(45) })).toThrow(/30 days/);
  });

  it('refuses a non-holder issuer and unsigned parents', () => {
    expect(() => attenuate(root, { issuerKey: staff, subject: staff.did, actions: ['pay:receive'], validUntil: inDays(30) })).toThrow(/subject/);
    const { proof: _p, ...unsigned } = root;
    expect(() => attenuate(unsigned, { issuerKey: owner, subject: staff.did, actions: ['pay:receive'], validUntil: inDays(30) })).toThrow(/signed/);
  });

  it('enforces depth: one level by default, more only if the root allows', () => {
    const child = signDocument(attenuate(root, { issuerKey: owner, subject: staff.did, actions: ['pay:receive'], validUntil: inDays(30) }), owner);
    const other = generateKeyPair();
    expect(() => attenuate(child, { issuerKey: staff, subject: other.did, actions: ['pay:receive'], validUntil: inDays(20) })).toThrow(/further/);

    const deepRoot = signDocument(buildAuthority({ issuer: podDid, subject: owner.did, scope: enterprise, actions: ['pay:receive'], validUntil: inDays(90), maxDepth: 2 }), podKey);
    const c1 = signDocument(attenuate(deepRoot, { issuerKey: owner, subject: staff.did, actions: ['pay:receive'], validUntil: inDays(30) }), owner);
    const c2 = signDocument(attenuate(c1, { issuerKey: staff, subject: other.did, actions: ['pay:receive'], validUntil: inDays(20) }), staff);
    expect(c2.credentialSubject['authority']).toMatchObject({ depth: 2, maxDepth: 2, parent: digestMultibase(c1) });
    expect(() => attenuate(c2, { issuerKey: other, subject: bob.did, actions: ['pay:receive'], validUntil: inDays(10) })).toThrow(/further/);
  });
});

describe('delegation chain (structural)', () => {
  const group = generateKeyPair();
  const s1 = generateKeyPair();
  const s2 = generateKeyPair();
  const hop = (issuer: string, subject: string, extra: Partial<Parameters<typeof buildDelegation>[0]> = {}) =>
    buildDelegation({ group: issuer, steward: subject, scope: ['round:vote'], validUntil: inDays(30), accepts: 'zQmAccepted', ...extra });

  it('accepts a single accepted hop', () => {
    expect(checkDelegationChain([hop(group.did, s1.did)], { actor: s1.did, requiredScope: 'round:vote' })).toEqual({ ok: true, principal: group.did });
  });

  it('requires acceptance', () => {
    const r = checkDelegationChain([hop(group.did, s1.did, { accepts: undefined })], { actor: s1.did, requiredScope: 'round:vote' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/accepted/);
  });

  it('requires the scope', () => {
    expect(checkDelegationChain([hop(group.did, s1.did)], { actor: s1.did, requiredScope: 'round:propose' }).ok).toBe(false);
  });

  it('respects maxDepth', () => {
    const shallow = [hop(group.did, s1.did), hop(s1.did, s2.did)];
    expect(checkDelegationChain(shallow, { actor: s2.did, requiredScope: 'round:vote' }).reason).toMatch(/depth/);
    const deep = [hop(group.did, s1.did, { maxDepth: 1 }), hop(s1.did, s2.did)];
    expect(checkDelegationChain(deep, { actor: s2.did, requiredScope: 'round:vote' })).toEqual({ ok: true, principal: group.did });
  });

  it('detects a broken hop, wrong actor and expiry', () => {
    const broken = [hop(group.did, s1.did, { maxDepth: 1 }), hop(bob.did, s2.did)];
    expect(checkDelegationChain(broken, { actor: s2.did, requiredScope: 'round:vote' }).reason).toMatch(/not issued/);
    expect(checkDelegationChain([hop(group.did, s1.did)], { actor: s2.did, requiredScope: 'round:vote' }).ok).toBe(false);
    expect(checkDelegationChain([hop(group.did, s1.did)], { actor: s1.did, requiredScope: 'round:vote', now: new Date(Date.now() + 31 * DAY) }).reason).toMatch(/expired/);
    expect(checkDelegationChain([], { actor: s1.did, requiredScope: 'round:vote' }).ok).toBe(false);
  });
});
