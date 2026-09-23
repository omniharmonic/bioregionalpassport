import {
  buildAuthority,
  buildDelegation,
  buildDelegationAcceptance,
  buildMembershipAck,
  buildMembershipGrant,
  createPresentation,
  createResolver,
  deriveRoundKey,
  didWebDocument,
  digestMultibase,
  generateKeyPair,
  keyPairForDid,
  keyPairFromSeed,
  randomNonce,
  signDocument,
  type KeyPair,
  type VerifiableCredential,
} from '@passport/credential-core';
import { createTestDb, createTestPod, withPod, type Db } from '@passport/db';
import { errorResult, type SessionClaims } from '@passport/service-kit';
import { boulderManifest, defaultTrustPolicy } from '@passport/tenant-config';
import { tierDefaultActions, type Tier } from '@passport/vocab';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalize } from '@passport/credential-core';
import { createRoundRoutes } from './routes.js';
import { ballotsHash, ROUND_WEIGHTS, tally, type PublishedBallot } from './tally.js';
import type { RoundContext, RoundRoute } from './types.js';

const SLUG = 'boulder';
const DOMAIN = 'bioregionalpassport.org';
const POD_DOMAIN = `${SLUG}.${DOMAIN}`;
const POD_DID = boulderManifest.identity.did;
const NOW = new Date('2026-09-22T18:00:00Z');
const DAY = 86_400_000;
const FROM = new Date(NOW.getTime() - DAY).toISOString();
const UNTIL = new Date(NOW.getTime() + 30 * DAY).toISOString();

const podKey = keyPairForDid(POD_DID, generateKeyPair().privateKey);
const resolver = createResolver({ staticDocs: { [POD_DID]: didWebDocument(POD_DID, podKey.publicKeyMultibase) } });

let db: Db;
let routes: RoundRoute[];

beforeAll(async () => {
  db = await createTestDb();
  await createTestPod(db, SLUG);
  routes = createRoundRoutes({ resolver });
});
afterAll(async () => {
  await db.close();
});

const ctxFor = (tx: Db, now: Date): RoundContext => ({
  slug: SLUG,
  podDid: POD_DID,
  db: tx,
  manifest: boulderManifest,
  policy: defaultTrustPolicy(POD_DID),
  now: () => now,
  platformDomain: DOMAIN,
});

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(':')) params[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

async function call(method: string, fullPath: string, opts: { body?: unknown; session?: SessionClaims; now?: Date } = {}): Promise<{ status: number; body: any }> {
  const [path, qs] = fullPath.split('?') as [string, string | undefined];
  for (const r of routes) {
    const params = r.method === method ? match(r.path, path) : null;
    if (!params) continue;
    const req = { params, query: Object.fromEntries(new URLSearchParams(qs ?? '')), body: opts.body, ...(opts.session ? { session: opts.session } : {}) };
    return withPod(db, SLUG, async (tx) => {
      try {
        const out = await r.handler(ctxFor(tx, opts.now ?? NOW), req);
        return { status: out.status ?? 200, body: out.body };
      } catch (e) {
        if (!(e instanceof Error) || e.name !== 'ServiceError') throw e;
        return errorResult(e);
      }
    });
  }
  throw new Error(`no route ${method} ${path}`);
}

const sessionOf = (did: string, tier: Tier): SessionClaims => ({ subject: did, pod: POD_DID, tier, authorities: tierDefaultActions(tier) });

interface Voter {
  seed: Uint8Array;
  persona: KeyPair;
  session: SessionClaims;
}
const newVoter = (tier: Tier): Voter => {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const persona = keyPairFromSeed(seed);
  return { seed, persona, session: sessionOf(persona.did, tier) };
};

function signBallot(seed: Uint8Array, roundId: string, allocations: Record<string, number>) {
  const key = deriveRoundKey(seed, roundId);
  return signDocument(
    { round: roundId, voterKey: key.did, issuer: key.did, allocations, createdAt: NOW.toISOString(), nonce: randomNonce() },
    key,
    { proofPurpose: 'assertionMethod', created: NOW.toISOString() },
  );
}

const ballotCount = async (roundId: string) =>
  withPod(db, SLUG, async (tx) => {
    const [b] = await tx.query(`SELECT count(*)::int AS n FROM ballots WHERE round_id = $1`, [roundId]);
    const [v] = await tx.query(`SELECT count(*)::int AS n FROM ballot_voters WHERE round_id = $1`, [roundId]);
    return { ballots: b.n as number, voters: v.n as number };
  });

describe('grants round — full lifecycle', () => {
  const steward = sessionOf(generateKeyPair().did, 'T3');
  const voters: Voter[] = [newVoter('T2'), newVoter('T2'), newVoter('T2'), newVoter('T2'), newVoter('T3')];
  const proposers = [newVoter('T2'), newVoter('T2'), newVoter('T2')];
  let roundId: string;
  let proposalIds: string[] = [];

  // Group vote fixtures: a group did:key delegates round:vote to a member steward.
  const groupSeed = crypto.getRandomValues(new Uint8Array(32));
  const group = keyPairFromSeed(groupSeed);
  const groupSteward = newVoter('T2');

  function groupPresentation(challenge: string, ownActions: string[] = tierDefaultActions('T1')) {
    const s = groupSteward.persona;
    const grant = signDocument(
      buildMembershipGrant({ pod: POD_DID, member: s.did, bioregion: SLUG, placeIds: ['huc12:101900050301'], governance: `https://${POD_DOMAIN}/governance`, validFrom: FROM, validUntil: UNTIL }),
      podKey,
    );
    const ack = signDocument(buildMembershipAck({ member: s.did, pod: POD_DID, grantDigest: digestMultibase(grant), validFrom: FROM, validUntil: UNTIL }), s);
    const delegation = signDocument(buildDelegation({ group: group.did, steward: s.did, scope: ['round:vote'], maxDepth: 0, validFrom: FROM, validUntil: UNTIL }), group);
    const acceptance = signDocument(
      buildDelegationAcceptance({ steward: s.did, group: group.did, grantDigest: digestMultibase(delegation), validFrom: FROM, validUntil: UNTIL, scope: ['round:vote'] }),
      s,
    );
    const vac = (subject: string, actions: string[], tier: string) =>
      signDocument(buildAuthority({ issuer: POD_DID, subject, scope: POD_DID, actions, validFrom: FROM, validUntil: UNTIL, policyVersion: 1, tier }), podKey);
    const creds: VerifiableCredential[] = [grant, ack, delegation, acceptance, vac(group.did, ['round:vote'], 'T2'), vac(s.did, ownActions, 'T1')];
    return createPresentation(creds, s, { challenge, domain: POD_DOMAIN });
  }

  it('a steward creates a draft round; a member without pep:review cannot', async () => {
    const body = {
      title: 'Autumn 2026 commons round',
      pool: 1000,
      opensAt: FROM,
      closesAt: new Date(NOW.getTime() + 7 * DAY).toISOString(),
      eligibility: { voiceBudget: 100 },
    };
    const refused = await call('POST', '/rounds', { session: voters[0]!.session, body });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('MISSING_AUTHORITY');
    const res = await call('POST', '/rounds', { session: steward, body });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'draft', pool: 1000, unit: 'credit', eligibility: { proposeTier: 'T2', voteTier: 'T2', voiceBudget: 100 } });
    roundId = res.body.id;
  });

  it('refuses ballots before the round is open', async () => {
    const res = await call('POST', `/rounds/${roundId}/ballots`, { session: voters[0]!.session, body: { ballot: signBallot(voters[0]!.seed, roundId, {}) } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROUND_NOT_OPEN');
  });

  it('opens the round and lists it by status', async () => {
    const res = await call('POST', `/rounds/${roundId}/open`, { session: steward });
    expect(res.body.status).toBe('open');
    const list = await call('GET', '/rounds?status=open');
    expect(list.body.rounds.map((r: any) => r.id)).toContain(roundId);
    expect((await call('GET', '/rounds?status=draft')).body.rounds.map((r: any) => r.id)).not.toContain(roundId);
  });

  it('T2 members propose; a T1 member is refused', async () => {
    for (const [i, p] of proposers.entries()) {
      const res = await call('POST', `/rounds/${roundId}/proposals`, {
        session: p.session,
        body: { title: `Project ${i + 1}`, summary: 'Creek restoration work', budget: 500 + i * 100, placeId: 'huc12:101900050301' },
      });
      expect(res.status).toBe(201);
      expect(res.body.leadDid).toBe(p.persona.did);
      expect(res.body.record).toMatchObject({ bioregion: SLUG, round: roundId, budget: 500 + i * 100, lead: p.persona.did, funded: false });
      proposalIds.push(res.body.id);
    }
    const t1 = await call('POST', `/rounds/${roundId}/proposals`, { session: sessionOf(generateKeyPair().did, 'T1'), body: { title: 'x', budget: 10 } });
    expect(t1.status).toBe(403);
    expect(t1.body.code).toBe('MISSING_AUTHORITY');
    const list = await call('GET', `/rounds/${roundId}/proposals`);
    expect(list.body.proposals).toHaveLength(3);
  });

  it('five voters cast ballots signed with their derived round keys', async () => {
    const allocs = [
      { [proposalIds[0]!]: 5, [proposalIds[1]!]: 5 },
      { [proposalIds[0]!]: 9 },
      { [proposalIds[1]!]: 3, [proposalIds[2]!]: 4 },
      { [proposalIds[2]!]: 10 },
      { [proposalIds[0]!]: 1, [proposalIds[2]!]: 7 },
    ];
    for (const [i, v] of voters.entries()) {
      const ballot = signBallot(v.seed, roundId, allocs[i]!);
      expect(ballot.voterKey).toBe(deriveRoundKey(v.seed, roundId).did);
      expect(ballot.voterKey).not.toBe(v.persona.did);
      const res = await call('POST', `/rounds/${roundId}/ballots`, { session: v.session, body: { ballot, linkage: {} } });
      expect(res.status).toBe(201);
      expect(res.body.replaced).toBe(false);
    }
    expect(await ballotCount(roundId)).toEqual({ ballots: 5, voters: 5 });
  });

  it('refuses an over-budget ballot with a plain sentence', async () => {
    const res = await call('POST', `/rounds/${roundId}/ballots`, {
      session: voters[0]!.session,
      body: { ballot: signBallot(voters[0]!.seed, roundId, { [proposalIds[0]!]: 8, [proposalIds[1]!]: 7 }) },
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: 'OVER_BUDGET', message: 'This ballot spends 113 voice credits but you have 100.' });
  });

  it('refuses a T1 voter (no round:vote) with a one-sentence explanation', async () => {
    const t1 = newVoter('T1');
    const res = await call('POST', `/rounds/${roundId}/ballots`, { session: t1.session, body: { ballot: signBallot(t1.seed, roundId, { [proposalIds[0]!]: 1 }) } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MISSING_AUTHORITY');
    expect(res.body.message).toBe('This needs the "round:vote" authority, which your passport does not carry.');
    expect(res.body.message.split('. ').length).toBe(1);
  });

  it('refuses a tampered ballot, a ballot for an unknown proposal, and a key already used by someone else', async () => {
    const v = voters[1]!;
    const tampered = { ...signBallot(v.seed, roundId, { [proposalIds[0]!]: 1 }), allocations: { [proposalIds[0]!]: 9 } };
    const bad = await call('POST', `/rounds/${roundId}/ballots`, { session: v.session, body: { ballot: tampered } });
    expect(bad.body.code).toBe('BAD_PROOF');
    const unknown = await call('POST', `/rounds/${roundId}/ballots`, { session: v.session, body: { ballot: signBallot(v.seed, roundId, { prp_nope: 1 }) } });
    expect(unknown.body.code).toBe('UNKNOWN_PROPOSAL');
    // voters[2]'s round key submitted under voters[3]'s session.
    const stolen = await call('POST', `/rounds/${roundId}/ballots`, { session: voters[3]!.session, body: { ballot: signBallot(voters[2]!.seed, roundId, {}) } });
    expect(stolen.status).toBe(409);
    expect(stolen.body.code).toBe('VOTER_KEY_IN_USE');
  });

  it('a second ballot from the same member replaces the first (one per voter)', async () => {
    const v = voters[1]!;
    const res = await call('POST', `/rounds/${roundId}/ballots`, { session: v.session, body: { ballot: signBallot(v.seed, roundId, { [proposalIds[0]!]: 6, [proposalIds[1]!]: 2 }) } });
    expect(res.status).toBe(201);
    expect(res.body.replaced).toBe(true);
    expect(await ballotCount(roundId)).toEqual({ ballots: 5, voters: 5 });
  });

  it('a steward votes for a group through a delegation chain; one ballot per group', async () => {
    const groupBallot = (allocations: Record<string, number>) => signBallot(groupSeed, roundId, allocations);
    const first = await call('POST', `/rounds/${roundId}/ballots`, {
      session: groupSteward.session,
      body: { ballot: groupBallot({ [proposalIds[2]!]: 5 }), linkage: { presentation: groupPresentation(roundId) } },
    });
    expect(first.status).toBe(201);
    expect(first.body.onBehalfOf).toBe(group.did);
    const second = await call('POST', `/rounds/${roundId}/ballots`, {
      session: groupSteward.session,
      body: { ballot: groupBallot({ [proposalIds[2]!]: 6 }), linkage: { presentation: groupPresentation(roundId) } },
    });
    expect(second.body.replaced).toBe(true);
    expect(await ballotCount(roundId)).toEqual({ ballots: 6, voters: 6 });

    // Bound to the round: a presentation made for another challenge is refused.
    const wrong = await call('POST', `/rounds/${roundId}/ballots`, {
      session: groupSteward.session,
      body: { ballot: groupBallot({ [proposalIds[2]!]: 6 }), linkage: { presentation: groupPresentation('another-round') } },
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('BAD_CHALLENGE');
    // Someone else's session cannot replay the steward's presentation.
    const replay = await call('POST', `/rounds/${roundId}/ballots`, {
      session: voters[0]!.session,
      body: { ballot: groupBallot({ [proposalIds[2]!]: 6 }), linkage: { presentation: groupPresentation(roundId) } },
    });
    expect(replay.body.code).toBe('HOLDER_MISMATCH');
    // The verifier prefers the holder's own round:vote authority, so such a presentation is not a group vote.
    const own = await call('POST', `/rounds/${roundId}/ballots`, {
      session: groupSteward.session,
      body: { ballot: groupBallot({ [proposalIds[2]!]: 6 }), linkage: { presentation: groupPresentation(roundId, tierDefaultActions('T2')) } },
    });
    expect(own.body.code).toBe('NOT_A_GROUP_VOTE');
  });

  it('keeps the tally private until the round closes', async () => {
    const res = await call('GET', `/rounds/${roundId}/tally`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TALLY_NOT_READY');
  });

  let stored: any;
  let published: PublishedBallot[];

  it('closes the round and tallies; the whole pool is matched', async () => {
    const res = await call('POST', `/rounds/${roundId}/close`, { session: steward });
    expect(res.status).toBe(200);
    expect(res.body.round.status).toBe('tallying');
    stored = res.body.tally;
    expect(stored.ballotCount).toBe(6);
    expect(stored.proposals).toHaveLength(3);
    expect(stored.totalMatching).toBe(1000);
    const p0 = stored.proposals.find((p: any) => p.id === proposalIds[0]);
    // voter0 5 (T2), voter1 6 (T2, replaced ballot), voter4 1 (T3)
    expect(p0.rawVotes).toBe(12);
    expect(p0.voters).toBe(3);
    expect(p0.voiceSum).toBeCloseTo(Math.sqrt(5) + Math.sqrt(6) + 1.2, 5);
    const late = await call('POST', `/rounds/${roundId}/ballots`, { session: voters[0]!.session, body: { ballot: signBallot(voters[0]!.seed, roundId, {}) } });
    expect(late.body.code).toBe('ROUND_NOT_OPEN');
  });

  it('publishes ballots without voter identities, and /verify recomputes the tally identically', async () => {
    const res = await call('GET', `/rounds/${roundId}/tally`);
    expect(res.status).toBe(200);
    published = res.body.ballots;
    expect(published).toHaveLength(6);
    const text = JSON.stringify(res.body);
    for (const v of [...voters, groupSteward]) expect(text).not.toContain(v.persona.did);
    expect(text).not.toContain('voter_hash');
    expect(published.filter((b) => b.onBehalfOf === group.did)).toHaveLength(1);
    expect(published.find((b) => b.onBehalfOf)!.tier).toBe('T2');
    expect(res.body.tally).toEqual(stored);

    // Anyone can recompute from the published output alone.
    const recomputed = tally(published, stored.proposals.map((p: any) => p.id), ROUND_WEIGHTS, stored.pool, {
      matchingCap: stored.matchingCap,
      adjustments: stored.adjustments,
      computedAt: stored.computedAt,
    });
    expect(canonicalize(recomputed)).toBe(canonicalize(stored));

    const verify = await call('GET', `/rounds/${roundId}/verify`);
    expect(verify.body.ok).toBe(true);
    expect(verify.body.problems).toEqual([]);
    expect(verify.body.recomputed).toEqual(verify.body.stored);
  });

  it('ballotsHash changes if a published ballot is altered', () => {
    expect(ballotsHash(published)).toBe(stored.ballotsHash);
    const altered = published.map((b, i) => (i === 0 ? { ...b, allocations: { ...b.allocations, [proposalIds[0]!]: 2 } } : b));
    expect(ballotsHash(altered)).not.toBe(stored.ballotsHash);
  });

  it('steward adjustments change matching, are listed in the tally, and the log is steward-only until published', async () => {
    const target = proposalIds[1]!;
    const before = stored.proposals.find((p: any) => p.id === target).matching;
    const noReason = await call('POST', `/rounds/${roundId}/adjustments`, { session: steward, body: { proposalId: target, delta: -50 } });
    expect(noReason.body.code).toBe('REASON_REQUIRED');
    const notSteward = await call('POST', `/rounds/${roundId}/adjustments`, { session: voters[0]!.session, body: { proposalId: target, delta: -50, reason: 'x' } });
    expect(notSteward.body.code).toBe('MISSING_AUTHORITY');
    const res = await call('POST', `/rounds/${roundId}/adjustments`, {
      session: steward,
      body: { proposalId: target, delta: -50, reason: 'Two ballots traced to one household (sybil review).' },
    });
    expect(res.status).toBe(201);
    const entry = res.body.tally.proposals.find((p: any) => p.id === target);
    expect(entry.matching).toBeCloseTo(before - 50, 2);
    expect(entry.adjustment).toBe(-50);
    expect(res.body.tally.adjustments).toEqual([
      { proposalId: target, delta: -50, reason: 'Two ballots traced to one household (sybil review).', stewardDid: steward.subject, createdAt: NOW.toISOString() },
    ]);
    expect(res.body.tally.totalMatching).toBe(950);
    stored = res.body.tally;
    expect((await call('GET', `/rounds/${roundId}/verify`)).body.ok).toBe(true);
    expect((await call('GET', `/rounds/${roundId}/adjustments`)).status).toBe(401);
    expect((await call('GET', `/rounds/${roundId}/adjustments`, { session: steward })).body.adjustments).toHaveLength(1);
  });

  it('publishes the round as open project records', async () => {
    const res = await call('POST', `/rounds/${roundId}/publish`, { session: steward });
    expect(res.status).toBe(200);
    expect(res.body.round.status).toBe('published');
    expect(res.body.round.publishedAt).toBe(NOW.toISOString());
    const rows = await withPod(db, SLUG, (tx) => tx.query(`SELECT * FROM records WHERE collection = 'project' ORDER BY uri`));
    expect(rows).toHaveLength(3);
    for (const id of proposalIds) {
      const row = rows.find((r: any) => r.uri === `at://${SLUG}/org.bioregion.project/${id}`);
      const entry = stored.proposals.find((p: any) => p.id === id);
      expect(row.author_did).toBe(POD_DID);
      expect(row.bioregion).toBe(SLUG);
      expect(row.place_id).toBe('huc12:101900050301');
      expect(row.record.funded).toBe(entry.matching > 0);
      expect(row.record.tally).toEqual(entry);
      expect(row.record.round).toBe(roundId);
    }
    expect((await call('GET', `/rounds/${roundId}/adjustments`)).body.adjustments).toHaveLength(1);
    const round = await call('GET', `/rounds/${roundId}`);
    expect(round.body.tally).toEqual(stored);
    expect(round.body.proposals).toHaveLength(3);
    expect((await call('GET', `/rounds/${roundId}/verify`)).body.ok).toBe(true);
    const again = await call('POST', `/rounds/${roundId}/publish`, { session: steward });
    expect(again.body.code).toBe('WRONG_ROUND_STATUS');
  });

  it('/verify notices a tampered stored ballot', async () => {
    await withPod(db, SLUG, (tx) =>
      tx.query(`UPDATE ballots SET ballot = jsonb_set(ballot, '{allocations}', '{}'::jsonb) WHERE round_id = $1 AND voter_key = $2`, [roundId, published[0]!.voterKey]),
    );
    const v = await call('GET', `/rounds/${roundId}/verify`);
    expect(v.body.ok).toBe(false);
    expect(v.body.problems.length).toBeGreaterThan(0);
  });
});
