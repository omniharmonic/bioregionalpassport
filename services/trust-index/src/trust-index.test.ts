import { buildEndorsement, createResolver, keyPairFromSeed, signDocument, type KeyPair } from '@passport/credential-core';
import { createTestDb, createTestPod, pendingMigrations, podSchema, withPod, type Db } from '@passport/db';
import type { RouteRequest, SessionClaims } from '@passport/service-kit';
import { ServiceError } from '@passport/service-kit';
import { defaultTrustPolicy, tenantZeroManifest, type TrustPolicy } from '@passport/tenant-config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitEdges, markWeighted, standingTier } from './commit.js';
import { stewardFlags } from './flags.js';
import { createTrustIndexRoutes, recommendTier, recomputeAll } from './service.js';
import type { IndexContext } from './types.js';

const POD_DID = 'did:web:bioregionalpassport.org:dids:tenant-zero';
const resolver = createResolver();
const keys = new Map<string, KeyPair>();
/** Deterministic did:key persona for `name` (resolves inline, no network). */
function persona(name: string): KeyPair {
  let k = keys.get(name);
  if (!k) {
    const seed = new Uint8Array(32);
    for (let i = 0; i < name.length; i++) seed[i % 32] = (seed[i % 32]! + name.charCodeAt(i) * (i + 1)) & 0xff;
    seed[31] = keys.size + 1;
    k = keyPairFromSeed(seed);
    keys.set(name, k);
  }
  return k;
}
const SEED_KEY = persona('seed');
const SEED = SEED_KEY.did;
const E1 = persona('e1');
const E2 = persona('e2');

/** A signed `dtg:endorses` VEC from `issuer` to `subject` (vary `created` for a distinct credential). */
function vec(
  issuer: KeyPair,
  subject: string,
  scope: 'lives-here' | 'worked-with' | 'knows' = 'knows',
  created = '2026-01-01T00:00:00Z',
) {
  return signDocument(buildEndorsement({ issuer: issuer.did, subject, scope, validFrom: created }), issuer, { created });
}
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
  /** A witness ref plus its stored VWC naming `parties` as the edge parties (as pod-vta `witnessEdge` writes). */
  witness(digest: string, eventId: string, convener: string, parties: readonly string[]): Promise<void>;
  post(poster: string, commitments: unknown[], now?: Date): Promise<void>;
  /** `to` opts in a VEC from `from` (a T2+ member) ⇒ weighted endorsement + link from → to. */
  endorse(from: KeyPair, to: string, scope?: 'lives-here' | 'worked-with' | 'knows'): Promise<void>;
  /** An `events` row of the given kind (`'event'` gathering or `'meeting'` peer-witnessing task). */
  task(id: string, kind: 'event' | 'meeting'): Promise<void>;
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
        await tx.query('INSERT INTO members (did, tier, vmc_grant_digest, vmc_ack_digest) VALUES ($1, $2, $3, $4)', [
          did,
          tier,
          `zGrant-${did}`,
          `zAck-${did}`,
        ]);
      }),
    witness: (digest, eventId, convener, parties) =>
      withPod(db, slug, async (tx) => {
        await tx.query('INSERT INTO witness_refs (digest, event_id, convener_did) VALUES ($1, $2, $3)', [digest, eventId, convener]);
        const vwc = {
          type: ['VerifiableCredential', 'StatementCredential'],
          issuer: POD_DID,
          credentialSubject: { predicate: 'dtg:witnessed', witnessedBy: convener, edgeParties: [...parties] },
        };
        await tx.query('INSERT INTO vta_witness_credentials (digest, vwc) VALUES ($1, $2)', [digest, JSON.stringify(vwc)]);
      }),
    post: async (poster, commitments, now = NOW) => {
      await pod.run((ctx) => commitEdges(ctx, poster, { commitments }, { resolver }), now);
    },
    endorse: (from, to, scope = 'knows') =>
      pod.post(to, [{ commitment: `endorse-${slug}-${++seq}-commitment`, scope, evidence: { vec: vec(from, to, scope) } }]),
    task: (id, kind) =>
      withPod(db, slug, async (tx) => {
        await tx.query('INSERT INTO events (id, title, kind, attestation) VALUES ($1, $2, $3, true)', [id, `Task ${id}`, kind]);
      }),
  };
  return pod;
}

/**
 * Member with 3 witnessed edges across 2 events (2 conveners), 2 weighted
 * endorsements (from T2 members E1, E2), `hops` from the seed. The hop chain is
 * seed → h1 → … → E2 → member, built only from verified weighted endorsements.
 */
async function trustedScenario(hops: number): Promise<{ pod: Pod; m: string }> {
  const pod = await newPod();
  const m = persona('member').did;
  await pod.member(SEED, 'T4');
  await pod.member(m, 'T1');
  await pod.member(E1.did, 'T2');
  await pod.member(E2.did, 'T2');
  await pod.witness('w1', 'event-1', 'did:key:zC1', [m, 'did:key:zO1']);
  await pod.witness('w2', 'event-1', 'did:key:zC2', [m, 'did:key:zO2']);
  await pod.witness('w3', 'event-2', 'did:key:zC1', [m, 'did:key:zO3']);
  await pod.post(m, [
    { commitment: 'commit-w1-aaaaaaaa', scope: 'relationship', witnessRef: 'w1' },
    { commitment: 'commit-w2-aaaaaaaa', scope: 'relationship', witnessRef: 'w2' },
    { commitment: 'commit-w3-aaaaaaaa', scope: 'relationship', witnessRef: 'w3' },
  ]);
  await pod.endorse(E1, m, 'lives-here');
  await pod.endorse(E2, m, 'knows');
  // seed → h1 → … → h(hops-2) → E2 (→ m already linked above)
  let prev = SEED_KEY;
  for (let i = 1; i <= hops - 2; i++) {
    const hop = persona(`hop-${i}`);
    await pod.member(hop.did, 'T2');
    await pod.endorse(prev, hop.did);
    prev = hop;
  }
  await pod.endorse(prev, E2.did);
  return { pod, m };
}

describe('trust index on PGlite', () => {
  it('a member with 1 witnessed edge is T1', async () => {
    const pod = await newPod();
    await pod.member(SEED, 'T4');
    await pod.member('did:key:zA', 'T1');
    await pod.witness('wa', 'event-1', 'did:key:zC1', ['did:key:zA', 'did:key:zB']);
    await pod.post('did:key:zA', [{ commitment: 'commit-a-1-aaaaaa', scope: 'relationship', witnessRef: 'wa' }]);
    const rec = await pod.run((ctx) => recommendTier(ctx, 'did:key:zA'));
    expect(rec.tier).toBe('T1');
    expect(rec.explanation).toContain('Your membership pair is complete.');
    expect(rec.explanation).toContain('1 of 1 witnessed edge.');
    expect(rec.explanation).toContain(
      '1 of 3 witnessed edges — get two more relationships witnessed by a convener at an attestation event.',
    );
    expect(rec.explanation).toContain(
      '1 of 2 different witnesses or gatherings — ask another neighbor to witness a relationship.',
    );
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
        // default policy `distinctEvents>=2` is evaluated as `distinctEventsOrWitnesses>=2` (peer witnessing on)
        '2 of 2 different witnesses or gatherings.',
        '2 of 2 weighted endorsements.',
        '3 hops from the seed set (3 or fewer needed).',
        'Spread across different witnesses and events is 0.67 (>= 0.5 needed).',
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
    await pod.witness('ws1', 'event-1', 'did:key:zC9', ['did:key:zS', 'did:key:zT1']);
    await pod.witness('ws2', 'event-2', 'did:key:zC9', ['did:key:zS', 'did:key:zT2']);
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
    await pod.witness('wn', 'event-3', 'did:key:zC3', ['did:key:zNew', 'did:key:zN2']);
    await pod.post('did:key:zNew', [{ commitment: 'new-1-aaaaaaaaaa', scope: 'relationship', witnessRef: 'wn' }]);
    const result = await pod.run((ctx) => recomputeAll(ctx));
    // T2: member; T1: zNew; T4: seed (recorded T4 by governance ⇒ namedInGovernance);
    // T0: E1, E2, hop-1 (recorded T2 but no witnessed edges of their own)
    expect(result.counts).toEqual({ T0: 3, T1: 1, T2: 1, T3: 0, T4: 1 });
    expect(result.total).toBe(6);
  });

  it('a pending applicant (no ack yet) or an expired membership recommends T0', async () => {
    const pod = await newPod();
    const P = 'did:key:zPending';
    const X = 'did:key:zExpired';
    await pod.run(async (ctx) => {
      await ctx.db.query("INSERT INTO members (did, tier, vmc_grant_digest) VALUES ($1, 'T0', 'zGrant')", [P]);
      await ctx.db.query(
        "INSERT INTO members (did, tier, vmc_grant_digest, vmc_ack_digest, valid_until) VALUES ($1, 'T1', 'zG', 'zA', $2)",
        [X, new Date(NOW.getTime() - 86_400_000)],
      );
    });
    await pod.witness('wp', 'event-1', 'did:key:zC1', [P, 'did:key:zP2']);
    await pod.witness('wq', 'event-1', 'did:key:zC1', [X, 'did:key:zX2']);
    await pod.post(P, [{ commitment: 'pending-1-aaaaaaa', scope: 'relationship', witnessRef: 'wp' }]);
    await pod.post(X, [{ commitment: 'expired-1-aaaaaaa', scope: 'relationship', witnessRef: 'wq' }]);

    const rec = await pod.run((ctx) => recommendTier(ctx, P));
    expect(rec.tier).toBe('T0');
    expect(rec.metrics).toMatchObject({ vmcPairComplete: false, membership: 'pending', witnessedEdges: 1 });
    expect(rec.explanation).toContain('Your membership is not complete until you acknowledge the grant.');
    expect(rec.next).toMatchObject({ tier: 'T1', missing: ['vmcPairComplete'] });

    const exp = await pod.run((ctx) => recommendTier(ctx, X));
    expect(exp.tier).toBe('T0');
    expect(exp.metrics.membership).toBe('expired');

    // once acknowledged, the same applicant is T1
    await pod.run((ctx) => ctx.db.query("UPDATE members SET vmc_ack_digest = 'zAck', tier = 'T1' WHERE did = $1", [P]));
    expect((await pod.run((ctx) => recommendTier(ctx, P))).tier).toBe('T1');
  });

  it('the pod migration creates the index tables (no runtime DDL)', async () => {
    const pod = await newPod();
    expect(await pendingMigrations(db, podSchema(pod.slug))).toEqual([]);
    const tables = await pod.run((ctx) =>
      ctx.db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name IN ('index_postings', 'index_links') ORDER BY table_name`,
      ),
    );
    expect(tables.map((t) => t.table_name)).toEqual(['index_links', 'index_postings']);
  });

  it('commit stores commitments with witness checks', async () => {
    const pod = await newPod();
    const P = 'did:key:zP';
    await pod.member(P, 'T1');
    await pod.witness('wx', 'event-1', 'did:key:zC1', [P, 'did:key:zQ']);
    const result = await pod.run((ctx) =>
      commitEdges(ctx, P, {
        commitments: [
          { commitment: 'edge-x-aaaaaaaa', scope: 'relationship', witnessRef: 'wx' },
          { commitment: 'edge-y-aaaaaaaa', scope: 'relationship', witnessRef: 'missing' },
          { commitment: 'edge-z-aaaaaaaa', scope: 'knows' },
        ],
      }),
    );
    expect(result).toMatchObject({ accepted: 3, duplicates: 0, rejected: 0 });
    expect(result.items[0]).toMatchObject({ witnessed: true, linked: false });
    expect(result.items[1]).toMatchObject({ witnessed: false });
    expect(result.items[1]!.note).toMatch(/not found/);
    expect(result.items[2]).toMatchObject({ weighted: false, linked: false });

    // the other party posts the same commitment: allowed; a third member (not an edge party) is refused
    await pod.post('did:key:zQ', [{ commitment: 'edge-x-aaaaaaaa', scope: 'relationship', witnessRef: 'wx' }]);
    await expect(
      pod.run((ctx) =>
        commitEdges(ctx, 'did:key:zR', { commitments: [{ commitment: 'edge-x2-aaaaaaa', scope: 'relationship', witnessRef: 'wx' }] }),
      ),
    ).rejects.toMatchObject({ status: 400, code: 'NOT_AN_EDGE_PARTY' });

    const dup = await pod.run((ctx) =>
      commitEdges(ctx, P, { commitments: [{ commitment: 'edge-x-aaaaaaaa', scope: 'relationship', witnessRef: 'wx' }] }),
    );
    expect(dup.items[0]).toMatchObject({ status: 'duplicate', witnessed: true });

    const mismatch = await pod.run((ctx) => commitEdges(ctx, P, { commitments: [{ commitment: 'edge-x-aaaaaaaa', scope: 'knows' }] }));
    expect(mismatch.items[0]).toMatchObject({ status: 'rejected' });

    // PEP marks the endorsement weighted after checking vec:issue:weighted (no link is created)
    expect(await pod.run((ctx) => markWeighted(ctx, P, ['edge-z-aaaaaaaa']))).toBe(1);
    const rec = await pod.run((ctx) => recommendTier(ctx, P));
    expect(rec.metrics.weightedEndorsements).toBe(1);
    expect(await pod.run((ctx) => ctx.db.query('SELECT * FROM index_links'))).toEqual([]);

    await expect(pod.run((ctx) => commitEdges(ctx, P, { commitments: [] }))).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_COMMIT',
    });
    await expect(
      pod.run((ctx) => commitEdges(ctx, P, { commitments: [{ commitment: 'edge-q-aaaaaaaa', scope: 'best-friend' }] })),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});

describe('endorsement evidence (VEC)', () => {
  const M = persona('evidence-member');
  const links = (pod: Pod) => pod.run((ctx) => ctx.db.query('SELECT from_did, to_did FROM index_links ORDER BY from_did'));
  const commitWith = (pod: Pod, poster: string, evidence: unknown, commitment = 'vec-commit-aaaaaaaa', scope = 'knows') =>
    pod.run((ctx) => commitEdges(ctx, poster, { commitments: [{ commitment, scope, evidence }] }, { resolver }));

  it('a bare self-asserted counterparty is impossible: the schema rejects the field', async () => {
    const pod = await newPod();
    await pod.member(E1.did, 'T2');
    await expect(
      pod.run((ctx) =>
        commitEdges(ctx, M.did, { commitments: [{ commitment: 'forged-aaaaaaaaa', scope: 'knows', counterparty: E1.did }] }, { resolver }),
      ),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_COMMIT' });
    expect(await links(pod)).toEqual([]);
  });

  it('a VEC signed by a real T2 member → weighted + link issuer → poster', async () => {
    const pod = await newPod();
    await pod.member(E1.did, 'T2');
    await pod.member(M.did, 'T1');
    const result = await commitWith(pod, M.did, { vec: vec(E1, M.did) });
    expect(result.items[0]).toMatchObject({ status: 'accepted', weighted: true, linked: true });
    expect(await links(pod)).toEqual([{ from_did: E1.did, to_did: M.did }]);
    const rec = await pod.run((ctx) => recommendTier(ctx, M.did));
    expect(rec.metrics.weightedEndorsements).toBe(1);
  });

  it('a VEC with a tampered proof → 400 BAD_EVIDENCE, nothing stored', async () => {
    const pod = await newPod();
    await pod.member(E1.did, 'T2');
    const good = vec(E1, M.did);
    const sig = good.proof.proofValue;
    const tampered = { ...good, proof: { ...good.proof, proofValue: sig.slice(0, -2) + (sig.endsWith('1') ? '22' : '11') } };
    await expect(commitWith(pod, M.did, { vec: tampered })).rejects.toMatchObject({ status: 400, code: 'BAD_EVIDENCE' });
    // tampered claim (scope changed after signing) also fails verification
    const edited = { ...good, credentialSubject: { ...good.credentialSubject, object: { id: M.did, value: { scope: 'lives-here' } } } };
    await expect(commitWith(pod, M.did, { vec: edited }, 'vec-commit-bbbbbbbb', 'lives-here')).rejects.toMatchObject({
      status: 400,
      code: 'BAD_EVIDENCE',
    });
    expect(await links(pod)).toEqual([]);
    expect(await pod.run((ctx) => ctx.db.query('SELECT * FROM index_postings'))).toEqual([]);
  });

  it('a VEC issued to someone else → 400 "This endorsement was not issued to you."', async () => {
    const pod = await newPod();
    await pod.member(E1.did, 'T2');
    await expect(commitWith(pod, M.did, { vec: vec(E1, 'did:key:zSomeoneElse') })).rejects.toMatchObject({
      status: 400,
      code: 'BAD_EVIDENCE',
      message: 'This endorsement was not issued to you.',
    });
    expect(await links(pod)).toEqual([]);
  });

  it('an issuer who is not a member → not weighted, no link; a T1 issuer → not weighted, no link', async () => {
    const pod = await newPod();
    const outsider = persona('outsider');
    const r1 = await commitWith(pod, M.did, { vec: vec(outsider, M.did) });
    expect(r1.items[0]).toMatchObject({ status: 'accepted', weighted: false, linked: false });
    expect(r1.items[0]!.note).toMatch(/not a member/);
    const t1 = persona('t1-endorser');
    await pod.member(t1.did, 'T1');
    const r2 = await commitWith(pod, M.did, { vec: vec(t1, M.did) }, 'vec-commit-cccccccc');
    expect(r2.items[0]).toMatchObject({ weighted: false, linked: false });
    expect(await links(pod)).toEqual([]);
  });

  it('a member at effective T2 (governance T1) gives a weighted vouch; an expired effective tier does not count', async () => {
    const pod = await newPod();
    const eff = persona('effective-t2');
    const lapsed = persona('lapsed-t2');
    await pod.member(M.did, 'T1');
    await pod.member(eff.did, 'T1');
    await pod.member(lapsed.did, 'T1');
    await pod.run(async (ctx) => {
      await ctx.db.query("UPDATE members SET effective_tier = 'T2', effective_until = $2 WHERE did = $1", [
        eff.did,
        new Date(NOW.getTime() + 86_400_000),
      ]);
      await ctx.db.query("UPDATE members SET effective_tier = 'T2', effective_until = $2 WHERE did = $1", [
        lapsed.did,
        new Date(NOW.getTime() - 86_400_000),
      ]);
    });
    const ok = await commitWith(pod, M.did, { vec: vec(eff, M.did) });
    expect(ok.items[0]).toMatchObject({ status: 'accepted', weighted: true, linked: true });
    const no = await commitWith(pod, M.did, { vec: vec(lapsed, M.did) }, 'vec-commit-dddddddd');
    expect(no.items[0]).toMatchObject({ weighted: false, linked: false });
    expect(no.items[0]!.note).toMatch(/below T2/);
    expect(await links(pod)).toEqual([{ from_did: eff.did, to_did: M.did }]);
  });

  it('standingTier is the higher of governance and a current effective tier', () => {
    expect(standingTier({ tier: 'T1', effective_tier: 'T2', effective_until: null }, NOW)).toBe('T2');
    expect(standingTier({ tier: 'T3', effective_tier: 'T2', effective_until: null }, NOW)).toBe('T3');
    expect(standingTier({ tier: 'T1', effective_tier: 'T3', effective_until: new Date(NOW.getTime() - 1) }, NOW)).toBe('T1');
    expect(standingTier({ tier: null, effective_tier: 'T2', effective_until: new Date(NOW.getTime() + 1) }, NOW)).toBe('T2');
    expect(standingTier({ tier: 'bogus', effective_tier: null, effective_until: null }, NOW)).toBe(null);
  });

  it('replaying the same VEC on a second commitment → 400 DUPLICATE_EVIDENCE (same request or later)', async () => {
    const pod = await newPod();
    await pod.member(E1.did, 'T2');
    await pod.member(M.did, 'T1');
    const v = vec(E1, M.did);
    await expect(
      pod.run((ctx) =>
        commitEdges(
          ctx,
          M.did,
          {
            commitments: [
              { commitment: 'replay-a-aaaaaaaa', scope: 'knows', evidence: { vec: v } },
              { commitment: 'replay-b-aaaaaaaa', scope: 'knows', evidence: { vec: v } },
            ],
          },
          { resolver },
        ),
      ),
    ).rejects.toMatchObject({ status: 400, code: 'DUPLICATE_EVIDENCE', message: 'This endorsement has already been counted.' });

    await commitWith(pod, M.did, { vec: v }, 'replay-a-aaaaaaaa');
    await expect(commitWith(pod, M.did, { vec: v }, 'replay-c-aaaaaaaa')).rejects.toMatchObject({
      status: 400,
      code: 'DUPLICATE_EVIDENCE',
    });
    // an identical retry of the same (commitment, VEC) is idempotent, not a replay
    const retry = await commitWith(pod, M.did, { vec: v }, 'replay-a-aaaaaaaa');
    expect(retry.items[0]).toMatchObject({ status: 'duplicate', weighted: true });
    expect((await pod.run((ctx) => recommendTier(ctx, M.did))).metrics.weightedEndorsements).toBe(1);
  });

  it('two different VECs from the same issuer count once; two issuers count twice', async () => {
    const pod = await newPod();
    await pod.member(E1.did, 'T2');
    await pod.member(E2.did, 'T2');
    await pod.member(M.did, 'T1');
    await commitWith(pod, M.did, { vec: vec(E1, M.did, 'knows', '2026-01-01T00:00:00Z') }, 'same-issuer-1-aaaa');
    await commitWith(pod, M.did, { vec: vec(E1, M.did, 'knows', '2026-02-01T00:00:00Z') }, 'same-issuer-2-aaaa');
    const once = await pod.run((ctx) => recommendTier(ctx, M.did));
    expect(once.metrics.weightedEndorsements).toBe(1);
    expect(once.metrics.endorsements).toBe(1);
    expect(once.metrics.endorsementSum).toBeCloseTo(0.5, 10); // one fresh `knows`

    await commitWith(pod, M.did, { vec: vec(E2, M.did, 'knows') }, 'other-issuer-aaaaa');
    const twice = await pod.run((ctx) => recommendTier(ctx, M.did));
    expect(twice.metrics.weightedEndorsements).toBe(2);
    expect(twice.metrics.endorsementSum).toBeCloseTo(1.0, 10);
  });

  it('evidence must match the commitment scope and cannot be self-issued', async () => {
    const pod = await newPod();
    await pod.member(E1.did, 'T2');
    await expect(commitWith(pod, M.did, { vec: vec(E1, M.did, 'knows') }, 'vec-commit-dddddddd', 'lives-here')).rejects.toMatchObject({
      code: 'BAD_EVIDENCE',
    });
    await expect(commitWith(pod, M.did, { vec: vec(M, M.did) })).rejects.toMatchObject({ code: 'BAD_EVIDENCE' });
  });
});

describe('witness claims (edge parties only)', () => {
  const A = 'did:key:zPartyA';
  const B = 'did:key:zPartyB';
  const C = 'did:key:zThirdMember';
  const claim = (pod: Pod, poster: string, commitment: string) =>
    pod.run((ctx) => commitEdges(ctx, poster, { commitments: [{ commitment, scope: 'relationship', witnessRef: 'wvwc' }] }));

  it("a third member claiming a real pair's VWC is refused and blocks nothing; both parties succeed", async () => {
    const pod = await newPod();
    for (const did of [A, B, C]) await pod.member(did, 'T1');
    await pod.witness('wvwc', 'event-1', 'did:key:zConv', [A, B]);

    // C computed the digest from the public relay result and claims it first: refused, nothing written.
    await expect(claim(pod, C, 'pair-edge-cccccccc')).rejects.toMatchObject({
      status: 400,
      code: 'NOT_AN_EDGE_PARTY',
      message: 'This witness credential is for a relationship you are not part of.',
    });
    expect(await pod.run((ctx) => ctx.db.query('SELECT * FROM index_postings WHERE poster_did = $1', [C]))).toEqual([]);

    const a = await claim(pod, A, 'pair-edge-aaaaaaaa');
    const b = await claim(pod, B, 'pair-edge-aaaaaaaa');
    expect(a.items[0]).toMatchObject({ status: 'accepted', witnessed: true });
    expect(b.items[0]).toMatchObject({ status: 'accepted', witnessed: true });
    expect((await pod.run((ctx) => recommendTier(ctx, A))).metrics.witnessedEdges).toBe(1);
    expect((await pod.run((ctx) => recommendTier(ctx, B))).metrics.witnessedEdges).toBe(1);
  });

  it('a witness ref with no stored credential cannot be claimed by anyone', async () => {
    const pod = await newPod();
    await pod.member(A, 'T1');
    await pod.run((ctx) =>
      ctx.db.query("INSERT INTO witness_refs (digest, event_id, convener_did) VALUES ('wvwc', 'event-1', 'did:key:zConv')"),
    );
    await expect(claim(pod, A, 'pair-edge-aaaaaaaa')).rejects.toMatchObject({ status: 400, code: 'NOT_AN_EDGE_PARTY' });
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
    await pod.witness('wr', 'event-1', 'did:key:zC1', ['did:key:zA', 'did:key:zB']);

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

describe('peer witnessing (meetings, Task 21b)', () => {
  /**
   * Member with 2 weighted endorsements (from T2 members E1, E2) at 3 hops from the seed and 3 witnessed edges,
   * one per entry of `witnesses`: `[taskId, kind, witnessDid]`.
   */
  async function peerScenario(witnesses: readonly [string, 'event' | 'meeting', string][]): Promise<{ pod: Pod; m: string }> {
    const pod = await newPod();
    const m = persona('peer-member').did;
    await pod.member(SEED, 'T4');
    await pod.member(m, 'T1');
    await pod.member(E1.did, 'T2');
    await pod.member(E2.did, 'T2');
    const tasks = new Set<string>();
    const commitments: unknown[] = [];
    for (const [i, [taskId, kind, witness]] of witnesses.entries()) {
      if (!tasks.has(taskId)) {
        await pod.task(taskId, kind);
        tasks.add(taskId);
      }
      await pod.witness(`pw${i}`, taskId, witness, [m, `did:key:zPeer${i}`]);
      commitments.push({ commitment: `peer-commit-${i}-aaaaaaa`, scope: 'relationship', witnessRef: `pw${i}` });
    }
    await pod.post(m, commitments);
    await pod.endorse(E1, m, 'lives-here');
    await pod.endorse(E2, m, 'knows');
    const hop = persona('peer-hop-1');
    await pod.member(hop.did, 'T2');
    await pod.endorse(SEED_KEY, hop.did);
    await pod.endorse(hop, E2.did);
    return { pod, m };
  }

  it('3 edges at 3 meetings by the same witness: distinctEvents 0, distinctWitnesses 1, spread 0.5, not T2', async () => {
    const W = 'did:key:zSameWitness';
    const { pod, m } = await peerScenario([
      ['meet-1', 'meeting', W],
      ['meet-2', 'meeting', W],
      ['meet-3', 'meeting', W],
    ]);
    const rec = await pod.run((ctx) => recommendTier(ctx, m));
    expect(rec.metrics).toMatchObject({
      witnessedEdges: 3,
      distinctEvents: 0,
      meetings: 3,
      distinctWitnesses: 1,
      weightedEndorsements: 2,
      seedHops: 3,
      spread: 0.5,
    });
    expect(rec.tier).toBe('T1');
    expect(rec.next).toMatchObject({ tier: 'T2', missing: ['distinctEvents>=2'] });
    expect(rec.next?.hints).toEqual(['1 of 2 different witnesses or gatherings — ask another neighbor to witness a relationship.']);
    // D = 0.6^3; E = 1.5 → 0.75; R = 0.5
    expect(rec.score).toBeCloseTo(0.216 * 3.75 * 0.5, 10);
  });

  it('two different witnesses across meetings meet distinctEventsOrWitnesses>=2 → T2', async () => {
    const { pod, m } = await peerScenario([
      ['meet-a', 'meeting', 'did:key:zWitnessA'],
      ['meet-b', 'meeting', 'did:key:zWitnessB'],
      ['meet-c', 'meeting', 'did:key:zWitnessA'],
    ]);
    const rec = await pod.run((ctx) => recommendTier(ctx, m));
    expect(rec.metrics).toMatchObject({ distinctEvents: 0, meetings: 3, distinctWitnesses: 2 });
    expect(rec.metrics.spread).toBeCloseTo(2 / 3, 10);
    expect(rec.tier).toBe('T2');
    expect(rec.explanation).toContain('2 of 2 different witnesses or gatherings.');
  });

  it('explicit distinctWitnesses / distinctEventsOrWitnesses requirements', async () => {
    const { pod, m } = await peerScenario([
      ['meet-a', 'meeting', 'did:key:zWitnessA'],
      ['meet-b', 'meeting', 'did:key:zWitnessB'],
      ['event-x', 'event', 'did:key:zWitnessA'],
    ]);
    pod.policy.tiers.T2.requires = ['distinctWitnesses>=2', 'distinctEventsOrWitnesses>=3'];
    const rec = await pod.run((ctx) => recommendTier(ctx, m));
    expect(rec.metrics).toMatchObject({ distinctEvents: 1, meetings: 2, distinctWitnesses: 2 });
    expect(rec.tier).toBe('T1');
    expect(rec.explanation).toContain('2 of 2 different witnesses.');
    expect(rec.next?.hints).toEqual(['2 of 3 different witnesses or gatherings — ask another neighbor to witness a relationship.']);
  });

  it('with admission.peerWitnessing false, distinctEvents>=2 is strict: meetings do not pass, two real events do', async () => {
    const strict = (pod: Pod) => {
      (pod.policy as unknown as { admission: { peerWitnessing: boolean } }).admission = { peerWitnessing: false };
    };
    const peers = await peerScenario([
      ['meet-a', 'meeting', 'did:key:zWitnessA'],
      ['meet-b', 'meeting', 'did:key:zWitnessB'],
      ['meet-c', 'meeting', 'did:key:zWitnessA'],
    ]);
    strict(peers.pod);
    const noEvents = await peers.pod.run((ctx) => recommendTier(ctx, peers.m));
    expect(noEvents.tier).toBe('T1');
    expect(noEvents.next?.hints).toEqual(['0 of 2 distinct events — attend two more attestation events.']);

    const events = await peerScenario([
      ['event-1', 'event', 'did:key:zConvener'],
      ['event-2', 'event', 'did:key:zConvener'],
      ['event-2', 'event', 'did:key:zConvener'],
    ]);
    strict(events.pod);
    const rec = await events.pod.run((ctx) => recommendTier(ctx, events.m));
    expect(rec.metrics).toMatchObject({ distinctEvents: 2, meetings: 0, distinctWitnesses: 1 });
    expect(rec.tier).toBe('T2');
    expect(rec.explanation).toContain('2 of 2 distinct events.');
  });

  /** A witnessed pair recorded at `at` (meeting unless `eventId` names a gathering), admitting `usedBy`. */
  async function pair(
    pod: Pod,
    digest: string,
    witness: string,
    parties: readonly string[],
    at: Date,
    usedBy: readonly string[] = [],
  ): Promise<void> {
    await pod.task(`meet-${digest}`, 'meeting');
    await pod.witness(digest, `meet-${digest}`, witness, parties);
    await pod.run((ctx) =>
      ctx.db.query('UPDATE witness_refs SET created_at = $2, used_by = $3 WHERE digest = $1', [digest, at, JSON.stringify(usedBy)]),
    );
  }

  it('witness-volume flag fires at 21 pairs in 7 days (default 20/week), not at 20; older pairs do not count', async () => {
    const pod = await newPod();
    const busy = 'did:key:zBusyWitness';
    const steady = 'did:key:zSteadyWitness';
    const dayAgo = new Date(NOW.getTime() - 86_400_000);
    for (let i = 0; i < 21; i++) await pair(pod, `busy-${i}`, busy, [`did:key:zB${i}a`, `did:key:zB${i}b`], dayAgo);
    for (let i = 0; i < 20; i++) await pair(pod, `steady-${i}`, steady, [`did:key:zS${i}a`, `did:key:zS${i}b`], dayAgo);
    for (let i = 0; i < 5; i++) {
      await pair(pod, `steady-old-${i}`, steady, [`did:key:zO${i}a`, `did:key:zO${i}b`], new Date(NOW.getTime() - 8 * 86_400_000));
    }
    const flags = await pod.run((ctx) => stewardFlags(ctx));
    expect(flags).toEqual([
      {
        did: busy,
        kind: 'witness-volume',
        detail: '21 relationships witnessed in the last 7 days (21 at meetings, 0 at events); the pod policy expects at most 20 per week.',
        since: dayAgo.toISOString(),
      },
    ]);
    // the limit is policy (anomaly.witnessPairsPerWeek); flags never change tiers or memberships
    (pod.policy.anomaly as { witnessPairsPerWeek?: number }).witnessPairsPerWeek = 25;
    expect(await pod.run((ctx) => stewardFlags(ctx))).toEqual([]);
  });

  it('hub flag: 5 admits witnessed by no one else; not at 4, not when one admit has another witness', async () => {
    const pod = await newPod();
    const hub = 'did:key:zHubWitness';
    const four = 'did:key:zFourWitness';
    const mixed = 'did:key:zMixedWitness';
    const at = new Date(NOW.getTime() - 30 * 86_400_000);
    for (let i = 0; i < 5; i++) await pair(pod, `hub-${i}`, hub, [`did:key:zH${i}`, `did:key:zHs${i}`], at, [`did:key:zH${i}`]);
    for (let i = 0; i < 4; i++) await pair(pod, `four-${i}`, four, [`did:key:zF${i}`, `did:key:zFs${i}`], at, [`did:key:zF${i}`]);
    for (let i = 0; i < 5; i++) await pair(pod, `mixed-${i}`, mixed, [`did:key:zM${i}`, `did:key:zMs${i}`], at, [`did:key:zM${i}`]);
    // one of the mixed witness's admits later has a relationship witnessed by someone else
    await pair(pod, 'mixed-other', 'did:key:zOtherWitness', ['did:key:zM0', 'did:key:zNeighbor'], at);

    const flags = await pod.run((ctx) => stewardFlags(ctx));
    expect(flags).toEqual([
      {
        did: hub,
        kind: 'witness-volume',
        detail: "All 5 members admitted with this witness's credentials have been witnessed by no one else.",
        since: at.toISOString(),
      },
    ]);
    expect(await pod.run((ctx) => ctx.db.query('SELECT count(*)::int AS n FROM members'))).toEqual([{ n: 0 }]);
  });
});
