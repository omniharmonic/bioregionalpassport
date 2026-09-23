import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createResolver } from '@passport/credential-core';
import { createTestDb, createTestPod, withPod, type Db } from '@passport/db';
import { createRoundRoutes } from '@passport/round';
import type { SessionClaims } from '@passport/service-kit';
import { matchRoute, type MountDeps, type MountableRoute } from '../../../../lib/mount';
import { ballotBody } from '../../../p/[slug]/grants/_lib/voting';
import { ROUND_MOUNT, mountRound } from './mount';

const POD_DID = 'did:web:bioregionalpassport.org:dids:boulder';
const OTHER_DID = 'did:web:bioregionalpassport.org:dids:tenant-zero';
const NOW = new Date('2026-09-22T12:00:00Z');
const seed = (n: number) => new Uint8Array(32).fill(n);

// Fake sessions: the cookie value is a key into this table.
const SESSIONS: Record<string, SessionClaims> = {
  newcomer: { subject: 'did:key:zNewcomer', pod: POD_DID, tier: 'T1', authorities: ['event:attend'] },
  voter: { subject: 'did:key:zVoter', pod: POD_DID, tier: 'T2', authorities: ['round:vote', 'round:propose'] },
  steward: { subject: 'did:key:zSteward', pod: POD_DID, tier: 'T3', authorities: ['pep:review', 'round:vote', 'round:propose'] },
  elsewhere: { subject: 'did:key:zOther', pod: OTHER_DID, tier: 'T3', authorities: ['pep:review'] },
};

let db: Db;

function fakeDeps(): MountDeps {
  return {
    platformDomain: 'bioregionalpassport.org',
    secureCookies: true,
    findPod: async (slug) =>
      slug === 'boulder'
        ? { slug, did: POD_DID, manifest: { identity: { slug, name: 'Boulder' }, currency: { unit: 'BOLT' } }, policy: { version: 1 }, status: 'active' }
        : null,
    withPod: (slug, fn) => withPod(db, slug, fn),
    platformDb: () => db,
    readSession: async (token) => SESSIONS[token] ?? null,
    now: () => NOW,
    logError: () => {},
  };
}

const deps = { resolver: createResolver() };
let svc: ReturnType<typeof mountRound>;

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, init: { cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (init.cookie) headers['cookie'] = `passport_session=${init.cookie}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`https://boulder.bioregionalpassport.org/api/round${path}`, {
    method,
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return svc[method](req);
}

beforeAll(async () => {
  db = await createTestDb();
  await createTestPod(db, 'boulder');
  svc = mountRound(deps, fakeDeps());
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('round route table', () => {
  it('mounts under /api/round with pod scope', () => {
    expect(ROUND_MOUNT).toEqual({ base: '/api/round', scope: 'pod' });
  });

  it('resolves every route of createRoundRoutes to itself', () => {
    const routes = createRoundRoutes(deps) as MountableRoute[];
    expect(routes.length).toBeGreaterThanOrEqual(13);
    for (const r of routes) {
      const concrete = r.path.replace(':id', 'rnd_x');
      const m = matchRoute(routes, r.method, concrete);
      expect(m.kind === 'match' && m.route).toBe(r);
    }
    expect(matchRoute(routes, 'POST', '/rounds/rnd_x/ballots')).toMatchObject({ kind: 'match', params: { id: 'rnd_x' } });
    expect(matchRoute(routes, 'DELETE', '/rounds').kind).toBe('method-not-allowed');
  });
});

describe('round mount (PGlite pod)', () => {
  let roundId = '';
  let proposalId = '';

  it('lists rounds publicly', async () => {
    const r = await call('GET', '/rounds');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ rounds: [] });
  });

  it('only stewards of this pod create and open rounds', async () => {
    const body = { title: 'Autumn commons', pool: 1000, opensAt: '2026-09-20T00:00:00Z', closesAt: '2026-10-20T00:00:00Z' };
    expect((await call('POST', '/rounds', { body })).status).toBe(401);
    const member = await call('POST', '/rounds', { cookie: 'voter', body });
    expect(member.status).toBe(403);
    expect((await member.json()).code).toBe('MISSING_AUTHORITY');
    expect((await call('POST', '/rounds', { cookie: 'elsewhere', body })).status).toBe(403);
    const created = await call('POST', '/rounds', { cookie: 'steward', body });
    expect(created.status).toBe(201);
    const round = await created.json();
    expect(round).toMatchObject({ title: 'Autumn commons', pool: 1000, unit: 'BOLT', status: 'draft', eligibility: { voiceBudget: 100 } });
    roundId = round.id;
    const opened = await call('POST', `/rounds/${roundId}/open`, { cookie: 'steward' });
    expect((await opened.json()).status).toBe('open');
  }, 30_000);

  it('members with round:propose add proposals', async () => {
    const r = await call('POST', `/rounds/${roundId}/proposals`, { cookie: 'voter', body: { title: 'Creek restoration', summary: 'Willows.', budget: 400 } });
    expect(r.status).toBe(201);
    proposalId = (await r.json()).id;
    expect((await call('POST', `/rounds/${roundId}/proposals`, { cookie: 'newcomer', body: { title: 'x', budget: 1 } })).status).toBe(403);
    const round = await (await call('GET', `/rounds/${roundId}`)).json();
    expect(round.proposals.map((p: { id: string }) => p.id)).toEqual([proposalId]);
  }, 30_000);

  it('ballots: needs a session, round:vote, and a budget-respecting ballot signed by the round key', async () => {
    const body = ballotBody(seed(9), roundId, { [proposalId]: 5 }, { now: NOW });
    expect((await call('POST', `/rounds/${roundId}/ballots`, { body })).status).toBe(401);
    const t1 = await call('POST', `/rounds/${roundId}/ballots`, { cookie: 'newcomer', body });
    expect(t1.status).toBe(403);
    expect(await t1.json()).toMatchObject({ code: 'MISSING_AUTHORITY', message: expect.stringContaining('round:vote') });
    const over = await call('POST', `/rounds/${roundId}/ballots`, { cookie: 'voter', body: ballotBody(seed(9), roundId, { [proposalId]: 11 }, { now: NOW }) });
    expect(over.status).toBe(400);
    expect(await over.json()).toMatchObject({ code: 'OVER_BUDGET', message: 'This ballot spends 121 voice credits but you have 100.' });
    const ok = await call('POST', `/rounds/${roundId}/ballots`, { cookie: 'voter', body });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ cost: 25, voiceBudget: 100, replaced: false, voterKey: body.ballot.voterKey });
  }, 30_000);

  it('the tally is published when the round closes, and verifies', async () => {
    expect((await call('GET', `/rounds/${roundId}/tally`)).status).toBe(409);
    expect((await call('POST', `/rounds/${roundId}/close`, { cookie: 'steward' })).status).toBe(200);
    const t = await (await call('GET', `/rounds/${roundId}/tally`)).json();
    expect(t.tally.proposals[0]).toMatchObject({ id: proposalId, votes: 5, voters: 1, matching: 1000 });
    expect(t.tally.verifiable.ballotsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.tally.adjustments).toBeUndefined();
    const v = await (await call('GET', `/rounds/${roundId}/verify`)).json();
    expect(v.ok).toBe(true);
  }, 30_000);
});
