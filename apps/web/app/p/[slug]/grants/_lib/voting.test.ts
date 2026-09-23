import { describe, expect, it } from 'vitest';
import {
  buildAuthority,
  buildDelegation,
  buildDelegationAcceptance,
  buildMembershipAck,
  buildMembershipGrant,
  createResolver,
  deriveRoundKey,
  digestMultibase,
  keyPairFromSeed,
  signDocument,
  verifyDocument,
  type VerifiableCredential,
} from '@passport/credential-core';
import {
  abbreviate,
  ballotBody,
  buildBallot,
  canAddVote,
  clampVotes,
  cleanAllocations,
  credentialOfRow,
  decodeSeed,
  groupVoteCredentials,
  groupsFor,
  meter,
  pickPersona,
  roundKeyFor,
  voiceCost,
} from './voting';

const seed = (n: number) => new Uint8Array(32).fill(n);
const resolver = createResolver();
const ROUND = 'rnd_abc123';

describe('cost meter', () => {
  it('charges Σ votes² against the budget', () => {
    expect(voiceCost({})).toBe(0);
    expect(voiceCost({ a: 3, b: 4 })).toBe(25);
    expect(meter({ a: 3, b: 4 }, 100)).toEqual({ cost: 25, budget: 100, remaining: 75, over: false, fraction: 0.25 });
    const over = meter({ a: 10, b: 1 }, 100);
    expect(over).toMatchObject({ cost: 101, remaining: -1, over: true, fraction: 1 });
  });

  it('many small voices cost less than one loud one', () => {
    expect(voiceCost({ a: 1, b: 1, c: 1, d: 1 })).toBeLessThan(voiceCost({ a: 4 }));
  });

  it('stepper limits: 0–10 and within budget', () => {
    expect(clampVotes(-2)).toBe(0);
    expect(clampVotes(12)).toBe(10);
    expect(clampVotes(3.7)).toBe(3);
    expect(canAddVote({ a: 9 }, 'a', 100)).toBe(true);
    expect(canAddVote({ a: 10 }, 'a', 1000)).toBe(false);
    expect(canAddVote({ a: 9, b: 4 }, 'b', 100)).toBe(false); // 81 + 25 > 100
    expect(canAddVote({ a: 9 }, 'b', 100)).toBe(true); // 81 + 1
  });

  it('drops zero and invalid allocations', () => {
    expect(cleanAllocations({ a: 0, b: 2, c: -1, d: 1.5 })).toEqual({ b: 2, d: 1 });
  });
});

describe('ballot construction', () => {
  it('signs { round, voterKey, issuer, allocations, createdAt, nonce } with the round key; verifyDocument accepts it', async () => {
    const key = deriveRoundKey(seed(7), ROUND);
    const ballot = buildBallot(key, ROUND, { prp_1: 3, prp_2: 0, prp_3: 1 }, new Date('2026-09-22T12:00:00Z'));
    expect(Object.keys(ballot).sort()).toEqual(['allocations', 'createdAt', 'issuer', 'nonce', 'proof', 'round', 'voterKey']);
    expect(ballot).toMatchObject({ round: ROUND, voterKey: key.did, issuer: key.did, allocations: { prp_1: 3, prp_3: 1 }, createdAt: '2026-09-22T12:00:00.000Z' });
    expect(ballot.nonce.length).toBeGreaterThanOrEqual(8);
    expect(ballot.proof.proofPurpose).toBe('assertionMethod');
    const r = await verifyDocument(ballot, resolver, { proofPurpose: 'assertionMethod' });
    expect(r).toEqual({ ok: true, controller: key.did });
  });

  it('a tampered ballot no longer verifies', async () => {
    const ballot = buildBallot(deriveRoundKey(seed(7), ROUND), ROUND, { prp_1: 3 });
    const r = await verifyDocument({ ...ballot, allocations: { prp_1: 9 } } as typeof ballot, resolver);
    expect(r.ok).toBe(false);
  });

  it('keys are per round and per group, never the persona key', () => {
    const personal = roundKeyFor(seed(1), ROUND);
    expect(personal.did).toBe(deriveRoundKey(seed(1), ROUND).did);
    expect(roundKeyFor(seed(1), 'rnd_other').did).not.toBe(personal.did);
    expect(roundKeyFor(seed(1), ROUND, 'did:key:zGroup').did).not.toBe(personal.did);
    expect(personal.did).not.toBe(keyPairFromSeed(seed(1)).did);
  });

  it('a personal ballot body has no linkage', () => {
    const body = ballotBody(seed(2), ROUND, { prp_1: 2 });
    expect(body.linkage).toBeUndefined();
    expect(body.ballot.voterKey).toBe(deriveRoundKey(seed(2), ROUND).did);
  });
});

describe('group votes', () => {
  const POD = 'did:key:' + keyPairFromSeed(seed(90)).publicKeyMultibase; // stand-in issuer for fixtures
  const podKey = keyPairFromSeed(seed(90));
  const group = keyPairFromSeed(seed(40));
  const persona = keyPairFromSeed(seed(3));
  const FROM = '2026-09-01T00:00:00Z';
  const UNTIL = '2026-11-01T00:00:00Z';
  const grant = signDocument(
    buildMembershipGrant({ pod: POD, member: persona.did, bioregion: 'boulder', placeIds: [], governance: 'https://boulder.example/governance', validFrom: FROM, validUntil: UNTIL }),
    podKey,
  );
  const ack = signDocument(buildMembershipAck({ member: persona.did, pod: POD, grantDigest: digestMultibase(grant), validFrom: FROM, validUntil: UNTIL }), persona);
  const delegation = signDocument(buildDelegation({ group: group.did, steward: persona.did, scope: ['round:vote'], validFrom: FROM, validUntil: UNTIL }), group);
  const acceptance = signDocument(
    buildDelegationAcceptance({ steward: persona.did, group: group.did, grantDigest: digestMultibase(delegation), validFrom: FROM, validUntil: UNTIL, scope: ['round:vote'] }),
    persona,
  );
  const groupVac = signDocument(buildAuthority({ issuer: POD, subject: group.did, scope: POD, actions: ['round:vote'], validFrom: FROM, validUntil: UNTIL, tier: 'T2' }), podKey);
  const ownVac = signDocument(buildAuthority({ issuer: POD, subject: persona.did, scope: POD, actions: ['round:vote', 'round:propose'], validFrom: FROM, validUntil: UNTIL, tier: 'T2' }), podKey);
  const all: VerifiableCredential[] = [grant, ack, delegation, acceptance, groupVac, ownVac];

  it('lists groups that delegated round:vote to the holder', () => {
    expect(groupsFor(all, persona.did)).toEqual([{ did: group.did, label: `Group ${abbreviate(group.did)}` }]);
    expect(groupsFor(all, 'did:key:zSomeoneElse')).toEqual([]);
  });

  it("presents membership + delegation + acceptance + the group's authority, never the holder's own round:vote", () => {
    const creds = groupVoteCredentials(all, persona.did, group.did);
    expect(creds).toEqual([grant, ack, delegation, acceptance, groupVac]);
    expect(creds).not.toContain(ownVac);
  });

  it('builds a group ballot body: group round key + holder presentation bound to the round', async () => {
    const body = ballotBody(seed(3), ROUND, { prp_1: 4 }, { group: group.did, credentials: all, domain: 'boulder.example.org' });
    expect(body.ballot.voterKey).toBe(roundKeyFor(seed(3), ROUND, group.did).did);
    expect((await verifyDocument(body.ballot, resolver, { proofPurpose: 'assertionMethod' })).ok).toBe(true);
    const vp = body.linkage!.presentation;
    expect(vp.holder).toBe(persona.did);
    expect(vp.proof).toMatchObject({ challenge: ROUND, domain: 'boulder.example.org', proofPurpose: 'authentication' });
    expect(vp.verifiableCredential).toHaveLength(5);
    expect((await verifyDocument(vp as never, resolver, { challenge: ROUND, domain: 'boulder.example.org' })).ok).toBe(true);
  });
});

describe('passport storage decoding', () => {
  it('decodes seeds stored as bytes, arrays, hex or base64url', () => {
    const s = seed(5);
    expect(decodeSeed(s)).toEqual(s);
    expect(decodeSeed(Array.from(s))).toEqual(s);
    expect(decodeSeed('05'.repeat(32))).toEqual(s);
    expect(decodeSeed('BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU')).toEqual(s);
    expect(decodeSeed('short')).toBeNull();
    expect(decodeSeed(new Uint8Array(16))).toBeNull();
  });

  it("picks the pod's persona: pods.personaDid first, else the directed identifier, never a pairwise one", () => {
    const rows = [
      { did: 'did:key:zPair', scope: 'pairwise', pod: 'boulder', seed: seed(1) },
      { did: 'did:key:zDirected', scope: 'directed', pod: 'boulder', seed: seed(2) },
      { did: 'did:key:zReused', scope: 'directed', pod: 'tenant-zero', seed: seed(3) },
    ];
    expect(pickPersona(rows)).toEqual(seed(2));
    expect(pickPersona(rows, 'did:key:zReused')).toEqual(seed(3));
    expect(pickPersona([rows[0]!])).toBeNull();
    expect(pickPersona([{ did: 'did:key:z', scope: 'directed' }])).toBeNull();
  });

  it('unwraps stored credential rows', () => {
    const vc = { type: ['X'], credentialSubject: { id: 'a' }, proof: {} };
    expect(credentialOfRow({ digest: 'z1', type: 'X', pod: 'boulder', raw: vc })).toBe(vc);
    expect(credentialOfRow({ digest: 'z1', type: 'X', pod: 'boulder', raw: vc, status: 'superseded' })).toBeNull();
    expect(credentialOfRow({ id: 1, pod: 'boulder', credential: vc })).toBe(vc);
    expect(credentialOfRow(vc)).toBe(vc);
    expect(credentialOfRow({ id: 1 })).toBeNull();
  });

  it('abbreviates identifiers', () => {
    expect(abbreviate('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK')).toBe('did:key:z6Mkha…2doK');
    expect(abbreviate('short')).toBe('short');
  });
});
