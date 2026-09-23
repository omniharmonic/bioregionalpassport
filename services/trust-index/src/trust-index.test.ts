import { createTestDb, createTestPod, withPod, type Db } from '@passport/db';
import type { RouteRequest, SessionClaims } from '@passport/service-kit';
import { ServiceError } from '@passport/service-kit';
import { defaultTrustPolicy, tenantZeroManifest, type TrustPolicy } from '@passport/tenant-config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitEdges, markWeighted } from './commit.js';
import { stewardFlags } from './flags.js';
import { createTrustIndexRoutes, recommendTier, recomputeAll } from './service.js';
import type { IndexContext } from './types.js';

const POD_DID = 'did:web:bioregionalpassport.org:dids:tenant-zero';
const SEED = 'did:key:zSeed';
const NOW = new Date('2026-09-22T12:00:00Z');

let db: Db;
let podCounter = 0;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

interface Pod {
  slug: string;
  policy: TrustPolicy;
  run<T>(fn: (ctx: IndexContext) => Promise<T>, now?: Date): Promise<T>;
  member(did: string, tier?: string): Promise<void>;
  witness(digest: string, eventId: string, convener: string): Promise<void>;
  post(poster: string, commitments: unknown[], now?: Date): Promise<void>;
  /** Posts a relationship commitment from `from` naming `to` as counterparty (creates link from → to). */
  link(from: string, to: string): Promise<void>;
}

async function newPod(): Promise<Pod> {
  const slug = `pod-${++podCounter}`;
  await createTestPod(db, slug);
  const policy: TrustPolicy = { ...defaultTrustPolicy(POD_DID), seedSet: [SEED] };
  let seq = 0;
  const pod: Pod = {
    slug,
    policy,
    run: (fn, now = NOW) =>
      withPod(db, slug, (tx) =>
        fn({ slug, podDid: POD_DID, db: tx, manifest: tenantZeroManifest, policy, now: () => now, platformDomain: 'bioregionalpassport.org' }),
      ),
    member: (did, tier = 'T1') =>
      withPod(db, slug, async (tx) => {
        await tx.query('INSERT INTO members (did, tier) VALUES ($1, $2)', [did, tier]);
      }),
    witness: (digest, eventId, convener) =>
      withPod(db, slug, async (tx) => {
        await tx.query('INSERT INTO witness_refs (digest, event_id, convener_did) VALUES ($1, $2, $3)', [digest, eventId, convener]);
      }),
    post: async (poster, commitments, now = NOW) => {
      await pod.run((ctx) => commitEdges(ctx, poster, { commitments }), now);
    },
    link: (from, to) => pod.post(from, [{ commitment: `link-${slug}-${++seq}-commitment`, scope: 'relationship', counterparty: to }]),
  };
  return pod;
}

/** Member with 3 witnessed edges across 2 events (2 conveners), 2 weighted endorsements, `hops` from the seed. */
async function trustedScenario(hops: number): Promise<{ pod: Pod; m: string }> {
  const pod = await newPod();
  const m = 'did:key:zMember';
  await pod.member(SEED, 'T4');
  await pod.member(m, 'T1');
  await pod.member('did:key:zE1', 'T2');
  await pod.member('did:key:zE2', 'T2');
  await pod.witness('w1', 'event-1', 'did:key:zC1');
  await pod.witness('w2', 'event-1', 'did:key:zC2');
  await pod.witness('w3', 'event-2', 'did:key:zC1');
  await pod.post(m, [
    { commitment: 'commit-w1-aaaaaaaa', scope: 'relationship', witnessRef: 'w1' },
    { commitment: 'commit-w2-aaaaaaaa', scope: 'relationship', witnessRef: 'w2' },
    { commitment: 'commit-w3-aaaaaaaa', scope: 'relationship', witnessRef: 'w3' },
    { commitment: 'endorse-1-aaaaaaaa', scope: 'lives-here', counterparty: 'did:key:zE1' },
    { commitment: 'endorse-2-aaaaaaaa', scope: 'knows', counterparty: 'did:key:zE2' },
  ]);
  // seed → h1 → … → m with exactly `hops` links
  let prev = SEED;
  for (let i = 1; i < hops; i++) {
    const next = `did:key:zHop${i}`;
    await pod.link(prev, next);
    prev = next;
  }
  await pod.link(prev, m);
  return { pod, m };
}

describe('trust index on PGlite', () => {
  it('a member with 1 witnessed edge is T1', async () => {
    const pod = await newPod();
    await pod.member(SEED, 'T4');
    await pod.member('did:key:zA', 'T1');
    await pod.witness('wa', 'event-1', 'did:key:zC1');
    await pod.post('did:key:zA', [{ commitment: 'commit-a-1-aaaaaa', scope: 'relationship', witnessRef: 'wa' }]);
    const rec = await pod.run((ctx) => recommendTier(ctx, 'did:key:zA'));
    expect(rec.tier).toBe('T1');
    expect(rec.explanation).toContain('Your membership pair is complete.');
    expect(rec.explanation).toContain('1 of 1 witnessed edge.');
    expect(rec.explanation).toContain(
      '1 of 3 witnessed edges — get two more relationships witnessed by a convener at an attestation event.',
    );
    expect(rec.explanation).toContain('1 of 2 distinct events — attend one more attestation event.');
    expect(rec.next?.tier).toBe('T2');
    expect(rec.next?.missing).toEqual(['witnessedEdges>=3', 'distinctEvents>=2', 'weightedEndorsements>=2', 'seedHops<=3']);
  });

  it('3 witnessed edges across 2 events, 2 weighted endorsements, within 3 hops → T2 with explanations', async () => {
    const { pod, m } = await trustedScenario(3);
    const rec = await pod.run((ctx) => recommendTier(ctx, m));
    expect(rec.tier).toBe('T2');
    expect(rec.metrics).toMatchObject({
      witnessedEdges: 3,
      distinctEvents: 2,
      distinctConveners: 2,
      weightedEndorsements: 2,
      seedHops: 3,
    });
    expect(rec.metrics.spread).toBeCloseTo(2 / 3, 10);
    const t2 = rec.requirements.filter((r) => r.tier === 'T2');
    expect(t2.map((r) => r.requirement)).toEqual(defaultTrustPolicy(POD_DID).tiers.T2.requires);
    expect(t2.every((r) => r.met)).toBe(true);
    expect(rec.explanation).toEqual(
      expect.arrayContaining([
        '3 of 3 witnessed edges.',
        '2 of 2 distinct events.',
        '2 of 2 weighted endorsements.',
        '3 hops from the seed set (3 or fewer needed).',
        'Spread across events is 0.67 (>= 0.5 needed).',
      ]),
    );
    expect(rec.next).toMatchObject({ tier: 'T3', missing: ['electedByGovernance', 'T2for>=180d'] });
    // D = 0.6^3; E = 1.0 + 0.5 (both fresh); score = 0.216 × (3 + 0.75) × 2/3
    expect(rec.score).toBeCloseTo(0.216 * 3.75 * (2 / 3), 10);
  });

  it('the same member at 4 hops is not T2 and next.missing names seedHops<=3', async () => {
    const { pod, m } = await trustedScenario(4);
    const rec = await pod.run((ctx) => recommendTier(ctx, m));
    expect(rec.tier).toBe('T1');
    expect(rec.metrics.seedHops).toBe(4);
    expect(rec.next?.tier).toBe('T2');
    expect(rec.next?.missing).toEqual(['seedHops<=3']);
    expect(rec.next?.hints[0]).toMatch(/^4 hops from the seed set \(3 or fewer needed\) — /);
  });

  it('velocity flag fires at 6 endorsements in a day (policy 5/day), not at 5; flags never change tiers', async () => {
    const pod = await newPod();
    await pod.member('did:key:zV', 'T1');
    await pod.member('did:key:zOk', 'T1');
    const endorsements = (who: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ commitment: `${who}-endorse-${i}-aaaa`, scope: 'knows' }));
    await pod.post('did:key:zV', endorsements('v', 6), new Date(NOW.getTime() - 3_600_000));
    await pod.post('did:key:zOk', endorsements('ok', 5), new Date(NOW.getTime() - 3_600_000));
    // old endorsements outside the 24 h window do not count
    await pod.post('did:key:zOk', endorsements('ok-old', 3), new Date(NOW.getTime() - 3 * 86_400_000));
    const flags = await pod.run((ctx) => stewardFlags(ctx));
    expect(flags).toEqual([
      {
        did: 'did:key:zV',
        kind: 'endorsement-velocity',
        detail: '6 endorsements in the last 24 hours; the pod policy expects at most 5 per day.',
        since: new Date(NOW.getTime() - 3_600_000).toISOString(),
      },
    ]);
    const members = await pod.run((ctx) => ctx.db.query('SELECT did, tier FROM members ORDER BY did'));
    expect(members).toEqual([
      { did: 'did:key:zOk', tier: 'T1' },
      { did: 'did:key:zV', tier: 'T1' },
    ]);
  });

  it('flags members whose witnessed edges all share a single convener', async () => {
    const pod = await newPod();
    await pod.member('did:key:zS', 'T1');
    await pod.witness('ws1', 'event-1', 'did:key:zC9');
    await pod.witness('ws2', 'event-2', 'did:key:zC9');
    await pod.post('did:key:zS', [
      { commitment: 'shared-1-aaaaaaaa', scope: 'relationship', witnessRef: 'ws1' },
      { commitment: 'shared-2-aaaaaaaa', scope: 'relationship', witnessRef: 'ws2' },
    ]);
    const flags = await pod.run((ctx) => stewardFlags(ctx));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ did: 'did:key:zS', kind: 'shared-witness-only' });
  });

  it('recompute returns counts by tier', async () => {
    const { pod } = await trustedScenario(3);
    await pod.member('did:key:zNew', 'T1');
    await pod.witness('wn', 'event-3', 'did:key:zC3');
    await pod.post('did:key:zNew', [{ commitment: 'new-1-aaaaaaaaaa', scope: 'relationship', witnessRef: 'wn' }]);
    const result = await pod.run((ctx) => recomputeAll(ctx));
    // T2: member; T1: zNew; T4: seed (recorded T4 by governance ⇒ namedInGovernance);
    // T0: E1, E2 (no edges of their own), hop1, hop2 (posters without membership)
    expect(result.counts).toEqual({ T0: 4, T1: 1, T2: 1, T3: 0, T4: 1 });
    expect(result.total).toBe(7);
  });

  it('commit stores commitments, witness checks and weighting', async () => {
    const pod = await newPod();
    await pod.member('did:key:zP', 'T1');
    await pod.member('did:key:zQ', 'T1');
    await pod.member('did:key:zT1', 'T1');
    await pod.witness('wx', 'event-1', 'did:key:zC1');
    const result = await pod.run((ctx) =>
      commitEdges(ctx, 'did:key:zP', {
        commitments: [
          { commitment: 'edge-x-aaaaaaaa', scope: 'relationship', witnessRef: 'wx', counterparty: 'did:key:zQ' },
          { commitment: 'edge-y-aaaaaaaa', scope: 'relationship', witnessRef: 'missing' },
          { commitment: 'edge-z-aaaaaaaa', scope: 'knows', counterparty: 'did:key:zT1' },
          { commitment: 'edge-self-aaaaa', scope: 'knows', counterparty: 'did:key:zP' },
        ],
      }),
    );
    expect(result).toMatchObject({ accepted: 3, duplicates: 0, rejected: 1 });
    expect(result.items[0]).toMatchObject({ witnessed: true, linked: true });
    expect(result.items[1]).toMatchObject({ witnessed: false });
    expect(result.items[1]!.note).toMatch(/not found/);
    expect(result.items[2]).toMatchObject({ weighted: false }); // counterparty only T1

    // the other party posts the same commitment: allowed; a third claimant is not credited
    await pod.post('did:key:zQ', [{ commitment: 'edge-x-aaaaaaaa', scope: 'relationship', witnessRef: 'wx' }]);
    const third = await pod.run((ctx) =>
      commitEdges(ctx, 'did:key:zR', { commitments: [{ commitment: 'edge-x2-aaaaaaa', scope: 'relationship', witnessRef: 'wx' }] }),
    );
    expect(third.items[0]).toMatchObject({ status: 'accepted', witnessed: false });

    const dup = await pod.run((ctx) =>
      commitEdges(ctx, 'did:key:zP', { commitments: [{ commitment: 'edge-x-aaaaaaaa', scope: 'relationship', witnessRef: 'wx' }] }),
    );
    expect(dup.items[0]).toMatchObject({ status: 'duplicate', witnessed: true });

    const mismatch = await pod.run((ctx) =>
      commitEdges(ctx, 'did:key:zP', { commitments: [{ commitment: 'edge-x-aaaaaaaa', scope: 'knows' }] }),
    );
    expect(mismatch.items[0]).toMatchObject({ status: 'rejected' });

    // PEP marks the endorsement weighted after checking vec:issue:weighted
    expect(await pod.run((ctx) => markWeighted(ctx, 'did:key:zP', ['edge-z-aaaaaaaa']))).toBe(1);
    const rec = await pod.run((ctx) => recommendTier(ctx, 'did:key:zP'));
    expect(rec.metrics.weightedEndorsements).toBe(1);

    await expect(pod.run((ctx) => commitEdges(ctx, 'did:key:zP', { commitments: [] }))).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_COMMIT',
    });
    await expect(
      pod.run((ctx) => commitEdges(ctx, 'did:key:zP', { commitments: [{ commitment: 'edge-q-aaaaaaaa', scope: 'best-friend' }] })),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});

describe('routes', () => {
  const routes = createTrustIndexRoutes();
  const route = (method: string, path: string) => routes.find((r) => r.method === method && r.path === path)!;
  const req = (session?: SessionClaims, body: unknown = null): RouteRequest => ({ params: {}, query: {}, body, ...(session ? { session } : {}) });
  const memberSession: SessionClaims = { subject: 'did:key:zA', pod: POD_DID, tier: 'T1', authorities: ['vec:issue'] };
  const steward: SessionClaims = { subject: 'did:key:zSt', pod: POD_DID, tier: 'T3', authorities: ['pep:review'] };

  it('declares the B3 §9 index routes with auth', () => {
    expect(routes.map((r) => [r.method, r.path, r.auth])).toEqual([
      ['POST', '/commit', 'member'],
      ['GET', '/me/explanation', 'member'],
      ['GET', '/steward/flags', 'authority:pep:review'],
      ['POST', '/recompute', 'operator'],
    ]);
  });

  it('commit → explanation → flags → recompute', async () => {
    const pod = await newPod();
    await pod.member('did:key:zA', 'T1');
    await pod.witness('wr', 'event-1', 'did:key:zC1');

    await expect(pod.run((ctx) => route('POST', '/commit').handler(ctx, req(undefined, {})))).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
    const posted = await pod.run((ctx) =>
      route('POST', '/commit').handler(
        ctx,
        req(memberSession, { commitments: [{ commitment: 'route-1-aaaaaaaa', scope: 'relationship', witnessRef: 'wr' }] }),
      ),
    );
    expect(posted.status).toBe(201);

    const explained = await pod.run((ctx) => route('GET', '/me/explanation').handler(ctx, req(memberSession)));
    expect(explained.body.tier).toBe('T1');
    expect(explained.body.explanation.length).toBeGreaterThan(0);

    await expect(pod.run((ctx) => route('GET', '/steward/flags').handler(ctx, req(memberSession)))).rejects.toMatchObject({
      status: 403,
      code: 'MISSING_AUTHORITY',
    });
    const flags = await pod.run((ctx) => route('GET', '/steward/flags').handler(ctx, req(steward)));
    expect(flags.body).toEqual({ flags: [] });

    const recomputed = await pod.run((ctx) => route('POST', '/recompute').handler(ctx, req()));
    expect(recomputed.body.counts.T1).toBe(1);
    expect(JSON.parse(JSON.stringify(recomputed.body)).total).toBe(1);
  });
});
