import { describe, expect, it } from 'vitest';
import {
  CONTEXTS,
  attenuate,
  buildAdjudication,
  buildAuthority,
  buildDelegation,
  buildDelegationAcceptance,
  checkAuthorityChain,
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
  type KeyPair,
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

  it('enforces B3 validity ceilings for witness, adjudication and root authority', () => {
    expect(() => buildWitness({ issuer: podDid, edgeDigest: 'e', taskContext: 't', taskDigest: 'd', evidence: 'liveness', validUntil: inDays(366) })).toThrow(/365 days/);
    expect(() => buildAdjudication({ steward: alice.did, subject: bob.did, disputedDigest: 'z', outcome: 'o', validUntil: inDays(366) })).toThrow(/365 days/);
    expect(() => buildAuthority({ issuer: podDid, subject: alice.did, scope: podDid, actions: ['event:attend'], validUntil: inDays(91) })).toThrow(/90 days/);
  });

  it('de-duplicates authority actions', () => {
    const vc = buildAuthority({ issuer: podDid, subject: alice.did, scope: podDid, actions: ['a', 'b', 'a'], validUntil: inDays(1) });
    expect(vc.credentialSubject['authority'].actions).toEqual(['a', 'b']);
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

  it('de-duplicates actions and checks the child validity window against the parent', () => {
    const child = attenuate(root, { issuerKey: owner, subject: staff.did, actions: ['pay:receive', 'pay:receive'], validUntil: inDays(30) });
    expect(child.credentialSubject['authority'].actions).toEqual(['pay:receive']);
    expect(() => attenuate(root, { issuerKey: owner, subject: staff.did, actions: ['pay:receive'], validFrom: new Date(Date.parse(root.validFrom) - DAY).toISOString(), validUntil: inDays(10) })).toThrow(/start before/);
    // 30-day ceiling measured from the child's validFrom
    expect(attenuate(root, { issuerKey: owner, subject: staff.did, actions: ['pay:receive'], validFrom: inDays(20), validUntil: inDays(45) }).validUntil).toBeDefined();
    expect(() => attenuate(root, { issuerKey: owner, subject: staff.did, actions: ['pay:receive'], validFrom: inDays(95), validUntil: inDays(96) })).toThrow();
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
  const grant = (issuer: KeyPair, subject: string, extra: Partial<Parameters<typeof buildDelegation>[0]> = {}) =>
    signDocument(buildDelegation({ group: issuer.did, steward: subject, scope: ['round:vote'], validUntil: inDays(30), ...extra }), issuer);
  const accept = (g: VerifiableCredential, steward: KeyPair, validUntil = inDays(30)) =>
    signDocument(buildDelegationAcceptance({ steward: steward.did, group: g.issuer, grantDigest: digestMultibase(g), validUntil, scope: g.credentialSubject['delegation'].scope }), steward);

  it('builds an acceptance mirroring the grant', () => {
    const g = grant(group, s1.did);
    const a = accept(g, s1);
    expect(a.type).toEqual(['VerifiableCredential', 'DelegationCredential']);
    expect(a.issuer).toBe(s1.did);
    expect(a.credentialSubject.id).toBe(group.did);
    expect(a.credentialSubject['delegation']).toEqual({ scope: ['round:vote'], accepts: digestMultibase(g) });
  });

  it('accepts a single accepted hop', () => {
    const g = grant(group, s1.did);
    expect(checkDelegationChain([g], { actor: s1.did, requiredScope: 'round:vote', acceptances: [accept(g, s1)] })).toEqual({ ok: true, principal: group.did });
  });

  it('requires a real acceptance of that exact grant by its steward', () => {
    const g = grant(group, s1.did);
    const none = checkDelegationChain([g], { actor: s1.did, requiredScope: 'round:vote', acceptances: [] });
    expect(none.ok).toBe(false);
    expect(none.reason).toMatch(/accepted/);
    // a truthy `accepts` on the grant itself is not acceptance
    const selfAccepted = grant(group, s1.did, { accepts: 'zQmWhatever' });
    expect(checkDelegationChain([selfAccepted], { actor: s1.did, requiredScope: 'round:vote', acceptances: [] }).ok).toBe(false);
    // acceptance of a different grant
    const other = grant(group, s1.did, { scope: ['round:vote', 'round:propose'] });
    expect(checkDelegationChain([g], { actor: s1.did, requiredScope: 'round:vote', acceptances: [accept(other, s1)] }).ok).toBe(false);
    // acceptance by someone other than the steward
    const forged = signDocument(buildDelegationAcceptance({ steward: s2.did, group: group.did, grantDigest: digestMultibase(g), validUntil: inDays(30) }), s2);
    expect(checkDelegationChain([g], { actor: s1.did, requiredScope: 'round:vote', acceptances: [forged] }).ok).toBe(false);
    // expired acceptance
    const a = accept(g, s1, inDays(1));
    expect(checkDelegationChain([g], { actor: s1.did, requiredScope: 'round:vote', acceptances: [a], now: new Date(Date.now() + 2 * DAY) }).ok).toBe(false);
  });

  it('requires the scope', () => {
    const g = grant(group, s1.did);
    expect(checkDelegationChain([g], { actor: s1.did, requiredScope: 'round:propose', acceptances: [accept(g, s1)] }).ok).toBe(false);
  });

  it('respects maxDepth', () => {
    const g1 = grant(group, s1.did);
    const g2 = grant(s1, s2.did);
    const acc = [accept(g1, s1), accept(g2, s2)];
    expect(checkDelegationChain([g1, g2], { actor: s2.did, requiredScope: 'round:vote', acceptances: acc }).reason).toMatch(/depth/);
    const d1 = grant(group, s1.did, { maxDepth: 1 });
    expect(checkDelegationChain([d1, g2], { actor: s2.did, requiredScope: 'round:vote', acceptances: [accept(d1, s1), accept(g2, s2)] })).toEqual({ ok: true, principal: group.did });
  });

  it('detects a broken hop, wrong actor and expiry', () => {
    const d1 = grant(group, s1.did, { maxDepth: 1 });
    const fromBob = grant(bob, s2.did);
    expect(checkDelegationChain([d1, fromBob], { actor: s2.did, requiredScope: 'round:vote', acceptances: [accept(d1, s1), accept(fromBob, s2)] }).reason).toMatch(/not issued/);
    const g = grant(group, s1.did);
    const acc = [accept(g, s1)];
    expect(checkDelegationChain([g], { actor: s2.did, requiredScope: 'round:vote', acceptances: acc }).ok).toBe(false);
    expect(checkDelegationChain([g], { actor: s1.did, requiredScope: 'round:vote', acceptances: acc, now: new Date(Date.now() + 31 * DAY) }).reason).toMatch(/expired/);
    expect(checkDelegationChain([], { actor: s1.did, requiredScope: 'round:vote', acceptances: [] }).ok).toBe(false);
  });
});

describe('authority chain (structural)', () => {
  const owner = generateKeyPair();
  const staff = generateKeyPair();
  const temp = generateKeyPair();
  const enterprise = 'did:web:bioregionalpassport.org:enterprises:bakery';
  const mkRoot = (maxDepth?: number) =>
    signDocument(buildAuthority({ issuer: podDid, subject: owner.did, scope: enterprise, actions: ['pay:receive', 'pay:refund'], validUntil: inDays(90), maxDepth }), podKey);

  it('accepts a root alone and a valid attenuation', () => {
    const root = mkRoot();
    expect(checkAuthorityChain([root])).toEqual({ ok: true, root });
    const child = signDocument(attenuate(root, { issuerKey: owner, subject: staff.did, actions: ['pay:receive'], validUntil: inDays(30) }), owner);
    expect(checkAuthorityChain([root, child])).toEqual({ ok: true, root });
  });

  it('accepts depth 2 only when the root allows it', () => {
    const root = mkRoot(2);
    const c1 = signDocument(attenuate(root, { issuerKey: owner, subject: staff.did, actions: ['pay:receive'], validUntil: inDays(30) }), owner);
    const c2 = signDocument(attenuate(c1, { issuerKey: staff, subject: temp.did, actions: ['pay:receive'], validUntil: inDays(20) }), staff);
    expect(checkAuthorityChain([root, c1, c2]).ok).toBe(true);
  });

  it('rejects hand-forged children that skip attenuate()', () => {
    const root = mkRoot();
    const c1 = signDocument(attenuate(root, { issuerKey: owner, subject: staff.did, actions: ['pay:receive'], validUntil: inDays(30) }), owner);
    const forge = (over: Record<string, any>, issuer = staff, extra: Record<string, any> = {}) =>
      signDocument(buildAuthority({ issuer: issuer.did, subject: temp.did, scope: enterprise, actions: ['pay:receive'], validUntil: inDays(20), parent: digestMultibase(c1), depth: 2, ...over, ...extra } as any), issuer);
    // depth beyond default root maxDepth (1), even if the forger lies about maxDepth
    expect(checkAuthorityChain([root, c1, forge({})]).reason).toMatch(/depth/);
    expect(checkAuthorityChain([root, c1, forge({ maxDepth: 5 })]).ok).toBe(false);
    // lying about depth
    const rootDeep = mkRoot(2);
    const d1 = signDocument(attenuate(rootDeep, { issuerKey: owner, subject: staff.did, actions: ['pay:receive'], validUntil: inDays(30) }), owner);
    const good = { parent: digestMultibase(d1), maxDepth: 2 };
    expect(checkAuthorityChain([rootDeep, d1, forge({ ...good, depth: 1 })]).reason).toMatch(/depth 2/);
    expect(checkAuthorityChain([rootDeep, d1, forge({ ...good, maxDepth: 3 })]).reason).toMatch(/maxDepth/);
    expect(checkAuthorityChain([rootDeep, d1, forge({ ...good, actions: ['pay:refund'] })]).reason).toMatch(/does not hold/);
    expect(checkAuthorityChain([rootDeep, d1, forge({ ...good, scope: 'did:web:other' })]).reason).toMatch(/scope/);
    expect(checkAuthorityChain([rootDeep, d1, forge({ ...good, parent: digestMultibase(rootDeep) })]).reason).toMatch(/parent/);
    expect(checkAuthorityChain([rootDeep, d1, forge(good, owner)]).reason).toMatch(/issued by the holder/);
    expect(checkAuthorityChain([rootDeep, d1, forge({ ...good, validUntil: inDays(31) })]).reason).toMatch(/outlives/);
    expect(checkAuthorityChain([rootDeep, d1, forge({ ...good, validFrom: new Date(Date.now() - DAY).toISOString() })]).reason).toMatch(/starts before/);
    expect(checkAuthorityChain([rootDeep, d1, forge(good)]).ok).toBe(true);
  });

  it('rejects a non-root first element and empty chains', () => {
    const root = mkRoot();
    const c1 = signDocument(attenuate(root, { issuerKey: owner, subject: staff.did, actions: ['pay:receive'], validUntil: inDays(30) }), owner);
    expect(checkAuthorityChain([c1]).ok).toBe(false);
    expect(checkAuthorityChain([]).ok).toBe(false);
  });
});
