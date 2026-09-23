import {
  buildEndorsement,
  buildMembershipAck,
  buildRelationship,
  buildWitness,
  createPresentation,
  createResolver,
  didWebDocument,
  digestMultibase,
  generateKeyPair,
  keyPairForDid,
  signDocument,
  verifyDocument,
  type KeyPair,
  type VerifiableCredential,
} from '@passport/credential-core';
import { createTestDb, createTestPod, withPod, type Db } from '@passport/db';
import { errorResult, type SessionClaims } from '@passport/service-kit';
import { boulderManifest, defaultTrustPolicy, type TrustPolicy } from '@passport/tenant-config';
import { ensureIndexTables, recommendTier } from '@passport/trust-index';
import { bitAt, decodeEncodedList, readSession } from '@passport/verifier-sdk';
import { tierDefaultActions, type Tier } from '@passport/vocab';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapSteward, ceremonyBackHalf } from './ceremony.js';
import { issueAuthorities, recordGovernanceTier, tierActions, validVacs } from './pep.js';
import { currentTier, witnessMeeting, witnessVolume } from './events.js';
import { edgePairDigest } from './edges.js';
import { DbChallengeStore, MemoryChallengeStore } from './challenges.js';
import { createPodVtaRoutes } from './routes.js';
import { RELAY_MAX_PER_CHANNEL, RelayStore } from './relay.js';
import type { PodSigner, PodVtaDeps, VtaContext, VtaRoute } from './types.js';

const SLUG = 'boulder';
const DOMAIN = 'bioregionalpassport.org';
const POD_DID = boulderManifest.identity.did;
const OTHER_POD = `did:web:${DOMAIN}:dids:elsewhere`;
const NOW = new Date('2026-09-22T18:00:00Z');
const DAY = 86_400_000;
const SECRET = 'test-session-secret-that-is-at-least-32-bytes-long';

const podKey = keyPairForDid(POD_DID, generateKeyPair().privateKey);
const otherKey = keyPairForDid(OTHER_POD, generateKeyPair().privateKey);
const signerFor = (key: KeyPair): PodSigner => ({ did: key.did, kid: key.kid, keyPair: key, sign: (doc, opts) => signDocument(doc, key, opts) });
const podSigner = signerFor(podKey);
const resolver = createResolver({
  staticDocs: {
    [POD_DID]: didWebDocument(POD_DID, podKey.publicKeyMultibase),
    [OTHER_POD]: didWebDocument(OTHER_POD, otherKey.publicKeyMultibase),
  },
});
// Most tests pin the pre-21c behaviour: a policy without `admission` (as pods provisioned before Task 21c carry), so
// T2 does not hold `vwc:issue` and admission has no witness-tier floor. Peer-witnessing tests opt in explicitly.
const { admission: _defaultAdmission, ...legacyPolicy } = defaultTrustPolicy(POD_DID);
const policy: TrustPolicy = legacyPolicy;

let db: Db;
let deps: PodVtaDeps;
let routes: VtaRoute[];

beforeAll(async () => {
  db = await createTestDb();
  await createTestPod(db, SLUG);
  await withPod(db, SLUG, (tx) => ensureIndexTables(tx));
  deps = {
    podSigner,
    resolver,
    sessionSecret: SECRET,
    index: { recommendTier: (ctx, did) => recommendTier(ctx, did) },
    challenges: new MemoryChallengeStore(),
    relay: new RelayStore(),
  };
  routes = createPodVtaRoutes(deps);
});
afterAll(async () => {
  await db.close();
});

const ctxFor = (tx: Db, now: Date, p: TrustPolicy = policy): VtaContext => ({
  slug: SLUG,
  podDid: POD_DID,
  db: tx,
  manifest: boulderManifest,
  policy: p,
  now: () => now,
  platformDomain: DOMAIN,
});
const run = <T>(fn: (ctx: VtaContext) => Promise<T>, now = NOW) => withPod(db, SLUG, (tx) => fn(ctxFor(tx, now)));

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

interface CallOpts {
  body?: unknown;
  session?: SessionClaims;
  now?: Date;
  routes?: VtaRoute[];
  /** Run outside `withPod` (as the platform relay would with a separate pool). */
  unscoped?: boolean;
  /** Trust policy for this call (default: `policy`). */
  policy?: TrustPolicy;
}

async function call(method: string, fullPath: string, opts: CallOpts = {}): Promise<{ status: number; body: any }> {
  const [path, qs] = fullPath.split('?') as [string, string | undefined];
  const table = opts.routes ?? routes;
  for (const r of table) {
    const params = r.method === method ? match(r.path, path) : null;
    if (!params) continue;
    const req = { params, query: Object.fromEntries(new URLSearchParams(qs ?? '')), body: opts.body, ...(opts.session ? { session: opts.session } : {}) };
    const exec = async (ctx: VtaContext) => {
      try {
        const out = await r.handler(ctx, req);
        return { status: out.status ?? 200, body: out.body };
      } catch (e) {
        if (!(e instanceof Error) || e.name !== 'ServiceError') throw e;
        return errorResult(e);
      }
    };
    const p = opts.policy ?? policy;
    return opts.unscoped ? exec(ctxFor(db, opts.now ?? NOW, p)) : withPod(db, SLUG, (tx) => exec(ctxFor(tx, opts.now ?? NOW, p)));
  }
  throw new Error(`no route ${method} ${path}`);
}

const sessionOf = (did: string, tier: Tier): SessionClaims => ({ subject: did, pod: POD_DID, tier, authorities: tierDefaultActions(tier) });

async function challenge(now = NOW): Promise<{ challenge: string; domain: string }> {
  const res = await call('GET', '/challenge', { now });
  expect(res.status).toBe(200);
  return res.body;
}

async function newEvent(steward: SessionClaims, startsAt = new Date(NOW.getTime() - 30 * 60_000)) {
  const res = await call('POST', '/events', {
    session: steward,
    body: { title: 'Creek cleanup', startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 3 * 3600_000).toISOString(), placeId: 'huc12:101900050301', lat: 40.01, lon: -105.27 },
  });
  expect(res.status).toBe(201);
  return res.body;
}

/** A signed VRC pair between two personas; the edge digest is the pair digest. */
function relationship(a: KeyPair, b: KeyPair, at = NOW) {
  const formedAt = at.toISOString();
  const vrcA = signDocument(buildRelationship({ issuer: a.did, subject: b.did, bioregion: SLUG, formedAt, validFrom: formedAt }), a);
  const vrcB = signDocument(buildRelationship({ issuer: b.did, subject: a.did, bioregion: SLUG, formedAt, validFrom: formedAt }), b);
  return { vrcA, vrcB, edgeDigest: edgePairDigest(vrcA, vrcB), edgeParties: [a.did, b.did], both: [vrcA, vrcB] };
}

async function witness(session: SessionClaims, eventId: string, edge: { vrcA: VerifiableCredential; vrcB: VerifiableCredential }, extra: Record<string, unknown> = {}) {
  const res = await call('POST', `/events/${eventId}/witness`, { session, body: { vrcA: edge.vrcA, vrcB: edge.vrcB, evidence: 'same-event', ...extra } });
  expect(res.status).toBe(201);
  return res.body.vwc as VerifiableCredential;
}

async function apply(key: KeyPair, vwc: unknown, creds: VerifiableCredential[], p?: TrustPolicy) {
  return call('POST', '/membership/apply', { body: { vwc, presentation: createPresentation(creds, key, await challenge()) }, ...(p ? { policy: p } : {}) });
}

async function admit(key: KeyPair, vwc: unknown, creds: VerifiableCredential[], p?: TrustPolicy) {
  const res = await apply(key, vwc, creds, p);
  expect(res.status).toBe(201);
  const grant = res.body.grant as VerifiableCredential;
  const ack = signDocument(
    buildMembershipAck({ member: key.did, pod: POD_DID, grantDigest: digestMultibase(grant), validFrom: NOW.toISOString(), validUntil: grant.validUntil! }),
    key,
  );
  const done = await call('POST', '/membership/ack', { body: { ack } });
  expect(done.status).toBe(200);
  return { grant, ack, vacs: done.body.vacs as VerifiableCredential[] };
}

const memberRow = (did: string) => run(async (ctx) => (await ctx.db.query('SELECT * FROM members WHERE did = $1', [did]))[0]);

describe('pod VTA — ceremony back half', () => {
  const steward = generateKeyPair();
  const alice = generateKeyPair();
  const bob = generateKeyPair();
  const stewardSession = sessionOf(steward.did, 'T3');
  let event: any;
  let edge: ReturnType<typeof relationship>;
  let vwc: VerifiableCredential;
  let grant: VerifiableCredential;
  let ack: VerifiableCredential;
  let vacs: VerifiableCredential[];

  it('bootstraps the first steward at T3 with a signed VAC', async () => {
    const out = await run((ctx) => bootstrapSteward(ctx, deps, steward.did));
    expect(out.member.tier).toBe('T3');
    const actions = out.vacs[0]!.credentialSubject['authority'].actions as string[];
    expect(actions).toEqual(expect.arrayContaining(['event:convene', 'vwc:issue', 'pep:review']));
    expect((await verifyDocument(out.vacs[0] as any, resolver)).ok).toBe(true);
    expect(await memberRow(steward.did)).toMatchObject({ tier: 'T3', effective_tier: 'T3' });
  });

  it('creates an attestation event with a Trust Task document and digest', async () => {
    event = await newEvent(stewardSession);
    expect(event.attestation).toBe(true);
    expect(event.taskDocument.type).toBe('org.bioregion.event.attestation');
    expect(event.taskDocument.conveners).toEqual([steward.did]);
    expect(event.taskDocument.pod).toBe(POD_DID);
    expect(event.taskDigest).toBe(digestMultibase(event.taskDocument));
    const list = await call('GET', '/events');
    expect(list.body.events.map((e: any) => e.id)).toContain(event.id);
    const one = await call('GET', `/events/${event.id}`);
    expect(one.body.taskDigest).toBe(event.taskDigest);
  });

  it('refuses event creation without event:convene, and authority sessions from another pod', async () => {
    const res = await call('POST', '/events', { session: sessionOf(alice.did, 'T1'), body: { title: 'x', startsAt: NOW.toISOString(), endsAt: new Date(NOW.getTime() + DAY).toISOString() } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MISSING_AUTHORITY');
    const foreign = await call('GET', '/steward/members', { session: { ...stewardSession, pod: OTHER_POD } });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe('POD_MISMATCH');
  });

  it('two personas form a VRC pair and a VEC; the steward witnesses the edge with both parties named', async () => {
    edge = relationship(alice, bob);
    const vec = signDocument(buildEndorsement({ issuer: bob.did, subject: alice.did, scope: 'lives-here', validFrom: NOW.toISOString() }), bob);
    expect((await verifyDocument(vec, resolver)).ok).toBe(true);

    const notConvener = await call('POST', `/events/${event.id}/witness`, { session: sessionOf(bob.did, 'T3'), body: { vrcA: edge.vrcA, vrcB: edge.vrcB, evidence: 'same-event' } });
    expect(notConvener.status).toBe(403);
    expect(notConvener.body.code).toBe('NOT_CONVENER');
    const oneHalf = await call('POST', `/events/${event.id}/witness`, { session: stewardSession, body: { vrcA: edge.vrcA, evidence: 'same-event' } });
    expect(oneHalf.status).toBe(400);
    expect(oneHalf.body.code).toBe('BAD_PAIR');
    const forgedHalf = { ...edge.vrcB, credentialSubject: { ...edge.vrcB.credentialSubject, formedAt: '2020-01-01T00:00:00Z' } };
    const forged = await call('POST', `/events/${event.id}/witness`, { session: stewardSession, body: { vrcA: edge.vrcA, vrcB: forgedHalf, evidence: 'same-event' } });
    expect(forged.status).toBe(400);

    vwc = await witness(stewardSession, event.id, edge);
    expect(vwc.issuer).toBe(POD_DID);
    expect(vwc.credentialSubject['witnessedBy']).toBe(steward.did);
    expect(vwc.credentialSubject['edgeParties']).toEqual([alice.did, bob.did]);
    expect(vwc.credentialSubject['object'].digestMultibase).toBe(edgePairDigest(edge.vrcB, edge.vrcA));
    expect(vwc.credentialSubject['taskContext']).toBe(event.id);
    expect(vwc.credentialSubject['taskDigestMultibase']).toBe(event.taskDigest);
    expect(Date.parse(vwc.validUntil!) - Date.parse(vwc.validFrom)).toBe(365 * DAY);
    expect((await verifyDocument(vwc as any, resolver)).ok).toBe(true);
  });

  it('witnesses a relationship at most once per pod; the same convener recovers the stored VWC', async () => {
    // Same convener, same event (halves swapped): the original VWC comes back (lost-response recovery).
    const same = await call('POST', `/events/${event.id}/witness`, { session: stewardSession, body: { vrcA: edge.vrcB, vrcB: edge.vrcA, evidence: 'liveness' } });
    expect(same.status).toBe(200);
    expect(same.body.existing).toBe(true);
    expect(digestMultibase(same.body.vwc)).toBe(digestMultibase(vwc));
    // Same convener, another event: still the one stored VWC.
    const other = await newEvent(stewardSession);
    const again = await call('POST', `/events/${other.id}/witness`, { session: stewardSession, body: { vrcA: edge.vrcA, vrcB: edge.vrcB, evidence: 'same-event' } });
    expect(again.status).toBe(200);
    expect(digestMultibase(again.body.vwc)).toBe(digestMultibase(vwc));
    // Another convener, another event: refused.
    const c2 = generateKeyPair();
    await run((ctx) => bootstrapSteward(ctx, deps, c2.did));
    const s2 = sessionOf(c2.did, 'T3');
    const ev2 = await newEvent(s2);
    const byOther = await call('POST', `/events/${ev2.id}/witness`, { session: s2, body: { vrcA: edge.vrcA, vrcB: edge.vrcB, evidence: 'same-event' } });
    expect(byOther.status).toBe(409);
    expect(byOther.body.code).toBe('ALREADY_WITNESSED');
    expect(byOther.body.message).toBe('This relationship has already been witnessed in this pod.');
    const rows = await run((ctx) => ctx.db.query('SELECT count(*)::int AS n FROM witness_refs WHERE pair_digest = $1', [edge.edgeDigest]));
    expect(rows[0].n).toBe(1);
  });

  it('refuses a convener witnessing their own relationship (SELF_WITNESS)', async () => {
    const friend = generateKeyPair();
    const own = relationship(steward, friend);
    const res = await call('POST', `/events/${event.id}/witness`, { session: stewardSession, body: { vrcA: own.vrcA, vrcB: own.vrcB, evidence: 'same-event' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_WITNESS');
    expect(res.body.message).toBe('A convener cannot witness their own relationship.');
    const flipped = await call('POST', `/events/${event.id}/witness`, { session: stewardSession, body: { vrcA: own.vrcB, vrcB: own.vrcA, evidence: 'same-event' } });
    expect(flipped.body.code).toBe('SELF_WITNESS');
  });

  it('refuses the VWC to three unrelated DIDs replaying it (EDGE_NOT_YOURS)', async () => {
    for (const _ of [1, 2, 3]) {
      const stranger = generateKeyPair();
      const own = relationship(stranger, generateKeyPair());
      const res = await apply(stranger, vwc, [edge.vrcA, edge.vrcB, own.vrcA, own.vrcB]);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('EDGE_NOT_YOURS');
      expect(res.body.message).toBe('This witness credential is for a relationship you are not part of.');
    }
  });

  it('refuses an application carrying only one half of the witnessed pair', async () => {
    for (const half of [edge.vrcA, edge.vrcB]) {
      const res = await apply(alice, vwc, [half]);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('EDGE_NOT_YOURS');
    }
  });

  it('applies with a VP bound to a fresh challenge and receives a signed grant (idempotently)', async () => {
    const c = await challenge();
    expect(c.domain).toBe(`${SLUG}.${DOMAIN}`);
    const res = await call('POST', '/membership/apply', { body: { vwc, presentation: createPresentation(edge.both, alice, c) } });
    expect(res.status).toBe(201);
    grant = res.body.grant;
    expect(grant.issuer).toBe(POD_DID);
    expect(grant.credentialSubject.id).toBe(alice.did);
    expect(grant.credentialSubject['placeIds']).toEqual(['huc12:101900050301']);
    expect(Date.parse(grant.validUntil!) - Date.parse(grant.validFrom)).toBe(90 * DAY - 60_000);

    const again = await apply(alice, vwc, edge.both);
    expect(again.status).toBe(200);
    expect(digestMultibase(again.body.grant)).toBe(digestMultibase(grant));
  });

  it('refuses an application whose challenge was already used', async () => {
    const presentation = createPresentation(edge.both, alice, await challenge());
    expect((await call('POST', '/membership/apply', { body: { vwc, presentation } })).status).toBe(200);
    const replay = await call('POST', '/membership/apply', { body: { vwc, presentation } });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('BAD_CHALLENGE');
  });

  it('refuses an ack with the wrong digest', async () => {
    const wrong = signDocument(
      buildMembershipAck({ member: alice.did, pod: POD_DID, grantDigest: 'zNotTheGrant', validFrom: NOW.toISOString(), validUntil: grant.validUntil! }),
      alice,
    );
    const res = await call('POST', '/membership/ack', { body: { ack: wrong } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DIGEST_MISMATCH');
  });

  it('refuses an ack signed by someone other than the member', async () => {
    const forged = signDocument(
      buildMembershipAck({ member: bob.did, pod: POD_DID, grantDigest: digestMultibase(grant), validFrom: NOW.toISOString(), validUntil: grant.validUntil! }),
      bob,
    );
    const res = await call('POST', '/membership/ack', { body: { ack: forged } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PAIR_INCOMPLETE');
  });

  it('ack completes the pair: member T1 with one VAC carrying the T1 default actions', async () => {
    ack = signDocument(
      buildMembershipAck({ member: alice.did, pod: POD_DID, grantDigest: digestMultibase(grant), validFrom: NOW.toISOString(), validUntil: grant.validUntil! }),
      alice,
    );
    const res = await call('POST', '/membership/ack', { body: { ack } });
    expect(res.status).toBe(200);
    expect(res.body.member).toEqual({ did: alice.did, tier: 'T1' });
    vacs = res.body.vacs;
    expect(vacs).toHaveLength(1);
    const vac = vacs[0]!;
    expect(vac.issuer).toBe(POD_DID);
    expect(vac.credentialSubject['authority'].scope).toBe(POD_DID);
    expect(vac.credentialSubject['authority'].actions).toEqual(tierDefaultActions('T1'));
    expect(vac.credentialSubject['tier']).toBe('T1');
    expect(vac.credentialSubject['policyVersion']).toBe(policy.version);
    expect(vac.credentialStatus.type).toBe('BitstringStatusListEntry');
    expect((await verifyDocument(vac as any, resolver)).ok).toBe(true);
    expect(res.body.explanation.join(' ')).toMatch(/pair is complete/);
    expect(await memberRow(alice.did)).toMatchObject({ tier: 'T1', effective_tier: 'T1' });

    const log = await call('GET', '/steward/vac-log', { session: stewardSession });
    expect(log.body.entries.some((e: any) => e.subject === alice.did && e.tier === 'T1')).toBe(true);
    const members = await call('GET', '/steward/members', { session: stewardSession });
    expect(members.body.members.find((m: any) => m.did === alice.did)).toMatchObject({ tier: 'T1', governanceTier: 'T1', status: 'member' });
  });

  it('admits the other genuine party with the same VWC, and no one else', async () => {
    const bobDone = await admit(bob, vwc, edge.both);
    expect(bobDone.vacs[0]!.credentialSubject.id).toBe(bob.did);
    const ref = await run(async (ctx) => (await ctx.db.query('SELECT used_by FROM witness_refs WHERE digest = $1', [digestMultibase(vwc)]))[0]);
    expect([...ref.used_by].sort()).toEqual([alice.did, bob.did].sort());
    const carol = generateKeyPair();
    const third = await apply(carol, vwc, edge.both);
    expect(third.status).toBe(403);
    expect(third.body.code).toBe('EDGE_NOT_YOURS');
  });

  it('refuses a VWC that has already admitted two people (WITNESS_USED)', async () => {
    const dan = generateKeyPair();
    const erin = generateKeyPair();
    const e2 = relationship(dan, erin);
    const v2 = await witness(stewardSession, event.id, e2);
    await run((ctx) => ctx.db.query(`UPDATE witness_refs SET used_by = '["did:key:zX","did:key:zY"]'::jsonb WHERE digest = $1`, [digestMultibase(v2)]));
    const res = await apply(dan, v2, e2.both);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WITNESS_USED');
  });

  it('a self-controlled pair still needs both signatures and admits at most two identities', async () => {
    const m1 = generateKeyPair();
    const m2 = generateKeyPair();
    const m3 = generateKeyPair();
    const pair = relationship(m1, m2);
    const v = await witness(stewardSession, event.id, pair);
    await admit(m1, v, pair.both);
    await admit(m2, v, pair.both);
    const extra = await apply(m3, v, pair.both);
    expect(extra.status).toBe(403);
    expect(extra.body.code).toBe('EDGE_NOT_YOURS');
  });

  it('refuses a VWC whose convener has since lost vwc:issue', async () => {
    const convener = generateKeyPair();
    const boot = await run((ctx) => bootstrapSteward(ctx, deps, convener.did));
    const session = sessionOf(convener.did, 'T3');
    const ev = await newEvent(session);
    const fay = generateKeyPair();
    const e3 = relationship(fay, generateKeyPair());
    const v3 = await witness(session, ev.id, e3);
    const revoked = await call('POST', '/authority/revoke', { session: stewardSession, body: { digest: digestMultibase(boot.vacs[0]), reason: 'stepped down' } });
    expect(revoked.status).toBe(200);
    const res = await apply(fay, v3, e3.both);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WITNESS_INVALID');
  });

  it('opens a member session from the membership pair + VAC; the token reads back', async () => {
    const c = await challenge();
    const presentation = createPresentation([grant, ack, ...vacs], alice, c);
    const res = await call('POST', '/session', { body: { presentation, requireAuthority: ['event:attend'] } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ subject: alice.did, tier: 'T1' });
    expect(res.body.authorities).toEqual([...tierDefaultActions('T1')].sort());
    const claims = await readSession(res.body.token, SECRET, NOW);
    expect(claims).toMatchObject({ subject: alice.did, pod: POD_DID, tier: 'T1' });

    const again = await call('POST', '/session', { body: { presentation } });
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('BAD_CHALLENGE');

    const missing = await call('POST', '/session', { body: { presentation: createPresentation([grant, ack, ...vacs], alice, await challenge()), requireAuthority: ['vwc:issue'] } });
    expect(missing.status).toBe(403);
    expect(missing.body.code).toBe('MISSING_AUTHORITY');
  });

  it('refuses an expired challenge', async () => {
    const c = await challenge();
    const res = await call('POST', '/session', {
      body: { presentation: createPresentation([grant, ack, ...vacs], alice, c) },
      now: new Date(NOW.getTime() + 6 * 60_000),
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('BAD_CHALLENGE');
  });

  it('opens a holder-only visitor session at T0', async () => {
    const res = await call('POST', '/session/visitor', { body: { presentation: createPresentation([], bob, await challenge()) } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ subject: bob.did, tier: 'T0', authorities: [] });
    const claims = await readSession(res.body.token, SECRET, NOW);
    expect(claims?.subject).toBe(bob.did);
    expect(claims?.pod).toBeUndefined();
    const stranger = generateKeyPair();
    const members = await call('POST', '/session', { body: { presentation: createPresentation([], stranger, await challenge()) } });
    expect(members.status).toBe(401);
    expect(members.body.code).toBe('NO_MEMBERSHIP');
  });

  it('refuses a VWC issued by another pod', async () => {
    const carol = generateKeyPair();
    const foreign = signDocument(
      buildWitness({
        issuer: OTHER_POD,
        edgeDigest: 'zEdge',
        taskContext: event.id,
        taskDigest: event.taskDigest,
        evidence: 'same-event',
        validFrom: NOW.toISOString(),
        validUntil: new Date(NOW.getTime() + 30 * DAY).toISOString(),
      }),
      otherKey,
    );
    const res = await apply(carol, foreign, []);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WITNESS_INVALID');
    expect(res.body.message).toBe("Admission needs a witness credential from one of this pod's attestation events.");
  });

  it('refuses a presentation with a bad proof', async () => {
    const vp = createPresentation(edge.both, alice, await challenge());
    const res = await call('POST', '/membership/apply', { body: { vwc, presentation: { ...vp, holder: bob.did } } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_PROOF');
  });

  it('a governance demotion sticks: effective tier holds until the VAC expires, then follows governance', async () => {
    const x = generateKeyPair();
    await run((ctx) => bootstrapSteward(ctx, deps, x.did));
    const refused = await call('POST', `/steward/members/${encodeURIComponent(x.did)}/tier`, { session: stewardSession, body: { tier: 'T1', reason: 'term ended' } });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('TIER_PROTECTED');
    // Governance body / operator path.
    await run((ctx) => recordGovernanceTier(ctx, x.did, 'T1', 'operator', 'term ended'));
    const s = sessionOf(x.did, 'T3');
    const early = await call('POST', '/authority/refresh', { session: s });
    expect(early.body.tier).toBe('T3');
    expect(early.body.explanation.join(' ')).toMatch(/stays at T3 until/);
    expect(await memberRow(x.did)).toMatchObject({ tier: 'T1', effective_tier: 'T3' });

    const later = await call('POST', '/authority/refresh', { session: s, now: new Date(NOW.getTime() + 91 * DAY) });
    expect(later.body.tier).toBe('T1');
    expect(later.body.vacs.map((v: any) => v.credentialSubject.tier)).toEqual(['T1']);
    const again = await call('POST', '/authority/refresh', { session: s, now: new Date(NOW.getTime() + 92 * DAY) });
    expect(again.body.tier).toBe('T1');
    expect(await memberRow(x.did)).toMatchObject({ tier: 'T1', effective_tier: 'T1' });
  });

  it('a bootstrapped steward keeps T3 after expiry (governance floor), even when the index recommends less', async () => {
    const toT1 = createPodVtaRoutes({ ...deps, index: { recommendTier: async () => ({ tier: 'T1', explanation: ['mocked T1'] }) } });
    const s = sessionOf(steward.did, 'T3');
    const early = await call('POST', '/authority/refresh', { session: s, routes: toT1 });
    expect(early.body.tier).toBe('T3');
    expect(early.body.issued).toBe(false);
    const later = await call('POST', '/authority/refresh', { session: s, routes: toT1, now: new Date(NOW.getTime() + 91 * DAY) });
    expect(later.body.tier).toBe('T3');
    expect(later.body.issued).toBe(true);
    expect(await memberRow(steward.did)).toMatchObject({ tier: 'T3', effective_tier: 'T3' });
  });

  it('refresh upgrades at once (effective tier only) and renews a VAC that is about to expire', async () => {
    const aliceReal = await call('POST', '/authority/refresh', { session: sessionOf(alice.did, 'T1') });
    expect(aliceReal.body.tier).toBe('T1');
    const mocked = createPodVtaRoutes({ ...deps, index: { recommendTier: async () => ({ tier: 'T2', explanation: ['mocked T2'] }) } });
    const up = await call('POST', '/authority/refresh', { session: sessionOf(alice.did, 'T1'), routes: mocked });
    expect(up.body.tier).toBe('T2');
    expect(up.body.issued).toBe(true);
    expect(up.body.vacs[0].credentialSubject.authority.actions).toEqual(tierDefaultActions('T2'));
    expect(await memberRow(alice.did)).toMatchObject({ tier: 'T1', effective_tier: 'T2' });
    const same = await call('POST', '/authority/refresh', { session: sessionOf(alice.did, 'T2'), routes: mocked });
    expect(same.body.issued).toBe(false);
    const nearExpiry = await call('POST', '/authority/refresh', { session: sessionOf(alice.did, 'T2'), routes: mocked, now: new Date(NOW.getTime() + 85 * DAY) });
    expect(nearExpiry.body.issued).toBe(true);
    expect(nearExpiry.body.tier).toBe('T2');
  });

  it('a re-applying former member starts again at T1 effective (governance floor), not their old effective tier', async () => {
    const toT2 = createPodVtaRoutes({ ...deps, index: { recommendTier: async () => ({ tier: 'T2', explanation: ['mocked T2'] }) } });
    await call('POST', '/authority/refresh', { session: sessionOf(bob.did, 'T1'), routes: toT2 });
    expect(await memberRow(bob.did)).toMatchObject({ tier: 'T1', effective_tier: 'T2' });

    const later = new Date(NOW.getTime() + 95 * DAY); // grant and VACs expired
    const ev = await call('POST', '/events', {
      session: stewardSession,
      now: later,
      body: { title: 'Autumn walk', startsAt: new Date(later.getTime() - 3600_000).toISOString(), endsAt: new Date(later.getTime() + 3600_000).toISOString() },
    });
    expect(ev.status).toBe(201);
    const peer = generateKeyPair();
    const at = later.toISOString();
    const pair = relationship(bob, peer, later);
    const w = await call('POST', `/events/${ev.body.id}/witness`, { session: stewardSession, now: later, body: { vrcA: pair.vrcA, vrcB: pair.vrcB, evidence: 'same-event' } });
    expect(w.status).toBe(201);
    const c = await challenge(later);
    const applied = await call('POST', '/membership/apply', { now: later, body: { vwc: w.body.vwc, presentation: createPresentation(pair.both, bob, c) } });
    expect(applied.status).toBe(201);
    const g = applied.body.grant as VerifiableCredential;
    const a = signDocument(buildMembershipAck({ member: bob.did, pod: POD_DID, grantDigest: digestMultibase(g), validFrom: at, validUntil: g.validUntil! }), bob);
    const done = await call('POST', '/membership/ack', { now: later, body: { ack: a } });
    expect(done.status).toBe(200);
    expect(done.body.member.tier).toBe('T1');
    expect(done.body.vacs[0].credentialSubject.tier).toBe('T1');
    expect(await memberRow(bob.did)).toMatchObject({ tier: 'T1', effective_tier: 'T1' });
  });

  it('stewards cannot change the tier of an anchor or a peer steward, nor raise anyone to T3', async () => {
    const anchor = generateKeyPair();
    const peer = generateKeyPair();
    await run(async (ctx) => {
      await ctx.db.query(`INSERT INTO members (did, tier) VALUES ($1, 'T1')`, [anchor.did]);
      await recordGovernanceTier(ctx, anchor.did, 'T4', 'operator', 'named in governance');
    });
    await run((ctx) => bootstrapSteward(ctx, deps, peer.did));
    for (const did of [anchor.did, peer.did]) {
      const res = await call('POST', `/steward/members/${encodeURIComponent(did)}/tier`, { session: stewardSession, body: { tier: 'T0', reason: 'hostile' } });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TIER_PROTECTED');
      expect(res.body.message).toBe('Only governance can change the tier of a steward or anchor.');
    }
    expect((await memberRow(anchor.did)).tier).toBe('T4');
    const raise = await call('POST', `/steward/members/${encodeURIComponent(alice.did)}/tier`, { session: stewardSession, body: { tier: 'T3', reason: 'promote' } });
    expect(raise.status).toBe(403);
    expect(raise.body.code).toBe('TIER_PROTECTED');
    const noReason = await call('POST', `/steward/members/${encodeURIComponent(alice.did)}/tier`, { session: stewardSession, body: { tier: 'T1' } });
    expect(noReason.status).toBe(400);
  });

  it('bootstrapSteward never lowers an existing T4 anchor', async () => {
    const anchor = generateKeyPair();
    await run(async (ctx) => {
      await ctx.db.query(`INSERT INTO members (did, tier) VALUES ($1, 'T1')`, [anchor.did]);
      await recordGovernanceTier(ctx, anchor.did, 'T4', 'operator', 'named in governance');
    });
    const out = await run((ctx) => bootstrapSteward(ctx, deps, anchor.did));
    expect(out.member.tier).toBe('T4');
    expect(out.vacs[0]!.credentialSubject['tier']).toBe('T4');
    expect(await memberRow(anchor.did)).toMatchObject({ tier: 'T4', effective_tier: 'T4' });
  });

  it('a steward demotion of a T2 member is logged with who, why and the previous tier', async () => {
    const m = generateKeyPair();
    await run(async (ctx) => {
      await ctx.db.query(`INSERT INTO members (did, tier) VALUES ($1, 'T1')`, [m.did]);
      await recordGovernanceTier(ctx, m.did, 'T2', 'operator', 'elected to T2 by assembly');
    });
    const res = await call('POST', `/steward/members/${encodeURIComponent(m.did)}/tier`, { session: stewardSession, body: { tier: 'T1', reason: 'inactive for a year' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ did: m.did, tier: 'T1', previous: 'T2' });
    const log = await call('GET', '/steward/governance-log', { session: stewardSession });
    expect(log.status).toBe(200);
    expect(log.body.entries[0]).toMatchObject({ subject: m.did, previousTier: 'T2', newTier: 'T1', by: steward.did, reason: 'inactive for a year' });
    const lower = await call('POST', `/steward/members/${encodeURIComponent(m.did)}/tier`, { session: { ...stewardSession, tier: 'T1' }, body: { tier: 'T0', reason: 'x' } });
    expect(lower.status).toBe(403);
  });

  it('refuses refresh for a session of another pod', async () => {
    const res = await call('POST', '/authority/refresh', { session: { ...sessionOf(alice.did, 'T1'), pod: OTHER_POD } });
    expect(res.status).toBe(403);
  });

  it('revokes a VAC; the status list flags it and sessions refuse it', async () => {
    const digest = digestMultibase(vacs[0]);
    const res = await call('POST', '/authority/revoke', { session: stewardSession, body: { digest, reason: 'lost device' } });
    expect(res.status).toBe(200);
    const list = await call('GET', '/status/vac');
    expect(list.body.type).toContain('BitstringStatusListCredential');
    expect((await verifyDocument(list.body, resolver)).ok).toBe(true);
    const bits = await decodeEncodedList(list.body.credentialSubject.encodedList);
    expect(bits.length * 8).toBeGreaterThanOrEqual(131_072);
    expect(bitAt(bits, Number(vacs[0]!.credentialStatus.statusListIndex))).toBe(true);
    expect(bitAt(bits, 0)).toBe(false);

    const session = await call('POST', '/session', { body: { presentation: createPresentation([grant, ack, vacs[0]!], alice, await challenge()) } });
    expect(session.status).toBe(401);
    expect(session.body.code).toBe('EXPIRED');
    expect(session.body.message).toMatch(/revoked/);
    expect((await call('GET', '/status/other')).status).toBe(404);
  });

  it('files and adjudicates a dispute; the adjudication subject comes from the dispute, not the body', async () => {
    const filed = await call('POST', '/disputes', { session: sessionOf(alice.did, 'T1'), body: { subjectDigest: digestMultibase(vwc), reason: 'I was not there' } });
    expect(filed.status).toBe(201);
    expect(filed.body.status).toBe('open');
    const list = await call('GET', '/steward/disputes', { session: stewardSession });
    expect(list.body.disputes.map((d: any) => d.id)).toContain(filed.body.id);
    const done = await call('POST', `/steward/disputes/${filed.body.id}/adjudicate`, { session: stewardSession, body: { outcome: 'upheld', subjectDid: bob.did } });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('adjudicated');
    const adj = done.body.adjudication;
    expect(adj.issuer).toBe(POD_DID);
    expect(adj.credentialSubject.id).toBe(alice.did);
    expect(adj.credentialSubject.adjudicatedBy).toBe(steward.did);
    expect(adj.credentialSubject.object.digestMultibase).toBe(digestMultibase(vwc));
    expect(adj.credentialSubject.predicate).toBe('bioregion:adjudicated');
    expect((await verifyDocument(adj, resolver)).ok).toBe(true);
    const noAuth = await call('GET', '/steward/disputes', { session: sessionOf(alice.did, 'T1') });
    expect(noAuth.status).toBe(403);
  });
});

describe('pod VTA — PEP audit log', () => {
  it('leaves no unsigned vac_issuance_log row when signing fails', async () => {
    const broken: PodSigner = { did: POD_DID, kid: podKey.kid, sign: () => { throw new Error('key unavailable'); } };
    const before = await run(async (ctx) => Number((await ctx.db.query('SELECT count(*)::int AS n FROM vac_issuance_log'))[0].n));
    await expect(run((ctx) => issueAuthorities(ctx, { podSigner: broken }, 'did:key:zNobody', 'T1', []))).rejects.toThrow(/key unavailable/);
    const after = await run(async (ctx) => Number((await ctx.db.query('SELECT count(*)::int AS n FROM vac_issuance_log'))[0].n));
    expect(after).toBe(before);
  });
});

describe('pod VTA — governance', () => {
  it('serves the latest signed policy and governance', async () => {
    expect((await call('GET', '/policy')).status).toBe(404);
    const signed = podSigner.sign({ ...policy });
    await run((ctx) => ctx.db.query('INSERT INTO policy_versions (version, policy, signed_at) VALUES ($1, $2, $3)', [1, JSON.stringify(signed), NOW.toISOString()]));
    const res = await call('GET', '/policy');
    expect(res.status).toBe(200);
    expect(res.body.proof).toBeDefined();
    const gov = await call('GET', '/governance');
    expect(gov.body.governance).toEqual(boulderManifest.governance);
    expect(gov.body.disclosure).toBe(boulderManifest.governance.disclosure);
    expect(gov.body.policy.version).toBe(1);
  });
});

describe('pod VTA — challenges', () => {
  it('in memory: single-use, scoped to the pod, expire by time', async () => {
    const store = new MemoryChallengeStore();
    const c = await store.issue('boulder', 'boulder.x', NOW);
    await expect(store.consume('tenant-zero', c.challenge, NOW)).rejects.toThrow(/not issued by this pod/);
    const c2 = await store.issue('boulder', 'boulder.x', NOW);
    expect(await store.consume('boulder', c2.challenge, NOW)).toEqual({ challenge: c2.challenge, domain: 'boulder.x' });
    await expect(store.consume('boulder', c2.challenge, NOW)).rejects.toThrow(/already been used/);
    const c3 = await store.issue('boulder', 'boulder.x', NOW);
    await expect(store.consume('boulder', c3.challenge, new Date(NOW.getTime() + 5 * 60_000))).rejects.toThrow(/expired/);
    // No size-based eviction: an early challenge survives a flood.
    const early = await store.issue('boulder', 'boulder.x', NOW);
    for (let i = 0; i < 12_000; i++) await store.issue('boulder', 'boulder.x', NOW);
    expect((await store.consume('boulder', early.challenge, NOW)).challenge).toBe(early.challenge);
  });

  it('in platform.relay_messages: single-use, scoped, expiring', async () => {
    const store = new DbChallengeStore(db);
    const c = await store.issue('boulder', 'boulder.x', NOW);
    const rows = await db.query(`SELECT body FROM platform.relay_messages WHERE channel = 'challenge:boulder' AND body->>'challenge' = $1`, [c.challenge]);
    expect(rows[0].body).toMatchObject({ challenge: c.challenge, domain: 'boulder.x', expiresAt: c.expiresAt });
    await expect(store.consume('tenant-zero', c.challenge, NOW)).rejects.toThrow(/not issued by this pod/);
    expect(await store.consume('boulder', c.challenge, NOW)).toEqual({ challenge: c.challenge, domain: 'boulder.x' });
    await expect(store.consume('boulder', c.challenge, NOW)).rejects.toThrow(/already been used/);
    const used = await db.query(`SELECT body FROM platform.relay_messages WHERE channel = 'challenge:boulder' AND body->>'challenge' = $1`, [c.challenge]);
    expect(used[0].body.usedAt).toBe(NOW.toISOString());
    const c2 = await store.issue('boulder', 'boulder.x', NOW);
    await expect(store.consume('boulder', c2.challenge, new Date(NOW.getTime() + 5 * 60_000))).rejects.toThrow(/expired/);
  });

  it('routes use the platform store when platformDb is configured', async () => {
    const withDb = createPodVtaRoutes({ ...deps, challenges: undefined, platformDb: db });
    const c = (await call('GET', '/challenge', { routes: withDb, unscoped: true })).body;
    const rows = await db.query(`SELECT 1 FROM platform.relay_messages WHERE channel = 'challenge:boulder' AND body->>'challenge' = $1`, [c.challenge]);
    expect(rows).toHaveLength(1);
    const visitor = generateKeyPair();
    const presentation = createPresentation([], visitor, c);
    const ok = await call('POST', '/session/visitor', { routes: withDb, unscoped: true, body: { presentation } });
    expect(ok.status).toBe(200);
    const replay = await call('POST', '/session/visitor', { routes: withDb, unscoped: true, body: { presentation } });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('BAD_CHALLENGE');
  });
});

describe('pod VTA — relay (ADR-22)', () => {
  const channel = 'chan_abcdefghijklmnop';
  const msg = (seq: number, type = 'org.bioregion.witness.request') => ({
    type,
    createdAt: NOW.toISOString(),
    seq,
    edgeDigest: 'zEdge',
    taskContext: 'evt_1',
    requester: 'did:key:zAlice',
  });

  async function exercise(opts: { routes?: VtaRoute[]; unscoped?: boolean }) {
    const old = await call('POST', `/relay/${channel}`, { ...opts, body: { sender: 'did:key:zOld', body: msg(0) }, now: new Date(NOW.getTime() - 25 * 3600_000) });
    expect(old.status).toBe(201);
    const seqs: number[] = [];
    for (const i of [1, 2, 3]) {
      const res = await call('POST', `/relay/${channel}`, { ...opts, body: { sender: 'did:key:zAlice', body: msg(i) }, now: new Date(NOW.getTime() + i * 1000) });
      expect(res.status).toBe(201);
      seqs.push(res.body.seq);
    }
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    const all = await call('GET', `/relay/${channel}`, { ...opts, now: new Date(NOW.getTime() + 5000) });
    expect(all.body.messages.map((m: any) => m.body.seq)).toEqual([1, 2, 3]);
    const after = await call('GET', `/relay/${channel}?after=${seqs[0]}`, { ...opts, now: new Date(NOW.getTime() + 5000) });
    expect(after.body.messages.map((m: any) => m.seq)).toEqual(seqs.slice(1));
    expect(after.body.messages[0].sender).toBe('did:key:zAlice');
    const other = await call('GET', '/relay/another_channel_xyz', opts);
    expect(other.body.messages).toEqual([]);

    const bad = await call('POST', `/relay/${channel}`, { ...opts, body: { sender: 'x', body: { type: 'org.bioregion.unknown' } } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('BAD_MESSAGE');
    const pay = await call('POST', `/relay/${channel}`, { ...opts, body: { sender: 'x', body: { type: 'org.bioregion.pay.receipt' } } });
    expect(pay.body.code).toBe('BAD_MESSAGE');
    const short = await call('POST', '/relay/short', { ...opts, body: { sender: 'x', body: msg(9) } });
    expect(short.status).toBe(400);
    expect(short.body.code).toBe('BAD_CHANNEL');
    // Oversized bodies are refused on size before any parsing (not a valid message either).
    const huge = await call('POST', `/relay/${channel}`, { ...opts, body: { sender: 'x', body: { type: 'nope', pad: 'x'.repeat(70 * 1024) } } });
    expect(huge.status).toBe(413);
    expect(huge.body.code).toBe('TOO_LARGE');
    // Measured in UTF-8 bytes: 40 K two-byte characters are 80 KB.
    const wide = await call('POST', `/relay/${channel}`, { ...opts, body: { sender: 'x', body: { ...msg(10), requester: 'é'.repeat(40 * 1024) } } });
    expect(wide.status).toBe(413);
  }

  async function fill(opts: { routes?: VtaRoute[]; unscoped?: boolean }) {
    const full = 'full_channel_0123456789';
    for (let i = 0; i < RELAY_MAX_PER_CHANNEL; i++) {
      const res = await call('POST', `/relay/${full}`, { ...opts, body: { sender: 's', body: msg(i) } });
      expect(res.status).toBe(201);
    }
    const over = await call('POST', `/relay/${full}`, { ...opts, body: { sender: 's', body: msg(999) } });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('CHANNEL_FULL');
    // After 24 h the old messages are pruned on append and the channel accepts again.
    const next = await call('POST', `/relay/${full}`, { ...opts, body: { sender: 's', body: msg(1000) }, now: new Date(NOW.getTime() + 25 * 3600_000) });
    expect(next.status).toBe(201);
  }

  it('appends and lists in order with a 24 h cutoff (in-memory ring)', async () => {
    const r = createPodVtaRoutes({ ...deps, relay: new RelayStore() });
    await exercise({ routes: r });
    await fill({ routes: r });
  });

  it('appends and lists in order with a 24 h cutoff (platform.relay_messages)', async () => {
    const r = createPodVtaRoutes({ ...deps, platformDb: db });
    await exercise({ routes: r, unscoped: true });
    const rows = await db.query(`SELECT channel FROM platform.relay_messages WHERE channel LIKE 'boulder:%' LIMIT 1`);
    expect(rows[0].channel).toBe(`${SLUG}:${channel}`);
    await fill({ routes: r, unscoped: true });
    const left = await db.query(`SELECT count(*)::int AS n FROM platform.relay_messages WHERE channel = 'boulder:full_channel_0123456789'`);
    expect(left[0].n).toBe(1);
  });
});

describe('pod VTA — in-process smoke', () => {
  const counts = () =>
    run(async (ctx) => {
      const out: Record<string, number> = {};
      for (const t of ['members', 'events', 'witness_refs', 'vac_issuance_log']) {
        out[t] = Number((await ctx.db.query(`SELECT count(*)::int AS n FROM ${t}`))[0].n);
      }
      return out;
    });

  it('ceremonyBackHalf runs witness → apply → ack → VACs with the control plane helpers and leaves no rows', async () => {
    const before = await counts();
    const res = await run((ctx) => ceremonyBackHalf(ctx, { signer: podSigner, resolver }));
    expect(res.ok).toBe(true);
    expect(res.eventId.startsWith('smoke-')).toBe(true);
    expect(res.vacs[0]!.credentialSubject['authority'].actions).toEqual(tierDefaultActions('T1'));
    expect(res.ack.credentialSubject['digestMultibase']).toBe(digestMultibase(res.grant));
    expect(await counts()).toEqual(before);
    const list = await call('GET', '/events');
    expect(list.body.events.some((e: any) => e.id.startsWith('smoke-'))).toBe(false);
  });

  it('ceremonyBackHalf passes with a 90-day policy on a real, advancing clock (verifyPod regression)', async () => {
    const p90: TrustPolicy = { ...policy, grantValidityDays: 90, vacValidityDays: 90 };
    let t = NOW.getTime();
    // Every clock read moves 250 ms on, like `() => new Date()` in verifyPod.
    const res = await withPod(db, SLUG, (tx) => ceremonyBackHalf({ ...ctxFor(tx, NOW, p90), now: () => new Date((t += 250)) }, { signer: podSigner, resolver }));
    expect(res.ok).toBe(true);
    for (const vc of [res.grant, res.ack, res.vacs[0]!]) {
      expect(Date.parse(vc.validUntil!) - Date.parse(vc.validFrom)).toBeLessThanOrEqual(90 * DAY - 60_000);
    }
    // Policies above the ceiling are clamped rather than rejected.
    const p120: TrustPolicy = { ...policy, grantValidityDays: 120, vacValidityDays: 120 };
    const clamped = await withPod(db, SLUG, (tx) => ceremonyBackHalf({ ...ctxFor(tx, NOW, p120), now: () => new Date((t += 250)) }, { signer: podSigner, resolver }));
    expect(Date.parse(clamped.grant.validUntil!) - Date.parse(clamped.grant.validFrom)).toBe(90 * DAY - 60_000);
    expect(Date.parse(clamped.vacs[0]!.validUntil!) - Date.parse(clamped.vacs[0]!.validFrom)).toBe(90 * DAY - 60_000);
  });

  it('ceremonyBackHalf accepts an explicit convener session, applicant key and event, and keeps pre-existing rows', async () => {
    const convener = generateKeyPair();
    await run((ctx) => bootstrapSteward(ctx, deps, convener.did));
    const session = sessionOf(convener.did, 'T3');
    const event = await newEvent(session);
    const before = await counts();
    const applicantKey = generateKeyPair();
    const res = await run((ctx) => ceremonyBackHalf(ctx, deps, { convenerSession: session, applicantKey, event }));
    expect(res.member).toBe(applicantKey.did);
    expect(res.eventId).toBe(event.id);
    expect(await counts()).toEqual(before);
    expect(await memberRow(convener.did)).toBeDefined();
  });
});

describe('pod VTA — peer witnessing: meetings as Trust Tasks (Task 21a)', () => {
  const steward = generateKeyPair();
  const w = generateKeyPair(); // Trusted (T2) member who witnesses peers
  const wPeer = generateKeyPair();
  const p1 = generateKeyPair();
  const p2 = generateKeyPair();
  const p3 = generateKeyPair();
  const p4 = generateKeyPair();
  const stewardSession = sessionOf(steward.did, 'T3');
  const pT2: TrustPolicy = { ...policy, admission: { witnessTier: 'T2', peerWitnessing: true } };
  const pT3: TrustPolicy = { ...policy, admission: { witnessTier: 'T3', peerWitnessing: true } };
  let wSession: SessionClaims;
  let edge12: ReturnType<typeof relationship>;
  let vwc12: VerifiableCredential;
  let task: any;
  let gathering: any;

  it('policy hook: vwc:issue joins the T2 action set only when admission.witnessTier ≤ T2; event:convene stays T3', async () => {
    const ctxOf = (p: TrustPolicy) => ({ policy: p });
    expect(tierActions(ctxOf(policy), 'T2')).not.toContain('vwc:issue');
    expect(tierActions(ctxOf(pT3), 'T2')).not.toContain('vwc:issue');
    expect(tierActions(ctxOf(pT2), 'T2')).toContain('vwc:issue');
    expect(tierActions(ctxOf(pT2), 'T2')).not.toContain('event:convene');
    expect(tierActions(ctxOf(pT2), 'T1')).not.toContain('vwc:issue');
    expect(tierActions(ctxOf(pT2), 'T3')).toEqual(tierDefaultActions('T3'));
    // The default policy for new pods (Task 21c) turns peer witnessing on: T2 witnesses, T1 does not.
    const fresh = defaultTrustPolicy(POD_DID);
    expect(fresh.admission).toEqual({ witnessTier: 'T2', peerWitnessing: true });
    expect(tierActions(ctxOf(fresh), 'T2')).toContain('vwc:issue');
    expect(tierActions(ctxOf(fresh), 'T1')).not.toContain('vwc:issue');
  });

  it('a T2 member under a witnessTier T2 policy receives vwc:issue at refresh', async () => {
    await run((ctx) => bootstrapSteward(ctx, deps, steward.did));
    gathering = await newEvent(stewardSession);
    const e = relationship(w, wPeer);
    const v = await witness(stewardSession, gathering.id, e);
    await admit(w, v, e.both);
    await run((ctx) => recordGovernanceTier(ctx, w.did, 'T2', 'operator', 'elected Trusted by assembly'));
    // Under the default policy the T2 VAC carries no vwc:issue.
    const plain = await call('POST', '/authority/refresh', { session: sessionOf(w.did, 'T1') });
    expect(plain.status).toBe(200);
    const plainActions = plain.body.vacs.flatMap((c: any) => c.credentialSubject.authority.actions as string[]);
    expect(plainActions).not.toContain('vwc:issue');
    // Under witnessTier T2 the held T2 VAC is incomplete, so refresh re-issues with vwc:issue.
    const res = await call('POST', '/authority/refresh', { session: sessionOf(w.did, 'T2'), policy: pT2 });
    expect(res.status).toBe(200);
    expect(res.body.issued).toBe(true);
    const actions = res.body.vacs[0].credentialSubject.authority.actions as string[];
    expect(actions).toContain('vwc:issue');
    expect(actions).not.toContain('event:convene');
    wSession = { subject: w.did, pod: POD_DID, tier: 'T2', authorities: actions };
  });

  it('a T2 witness witnesses a pair via POST /witness with no event; the VWC is bound to a meeting Trust Task', async () => {
    edge12 = relationship(p1, p2);
    const res = await call('POST', '/witness', {
      session: wSession,
      body: { vrcA: edge12.vrcA, vrcB: edge12.vrcB, evidence: 'liveness', place: { placeId: 'huc12:101900050301', lat: 40.02, lon: -105.28, name: 'Farmers market' } },
    });
    expect(res.status).toBe(201);
    vwc12 = res.body.vwc;
    task = res.body.task;
    expect(task.id).toMatch(/^meet-[A-Za-z0-9_-]{16}$/);
    expect(task.kind).toBe('meeting');
    expect(task.title).toMatch(/^Meeting witnessed by did:key:/);
    expect(task.title.length).toBeLessThan(w.did.length + 25);
    expect(task.conveners).toEqual([w.did]);
    expect(task.attestation).toBe(true);
    expect(task.placeId).toBe('huc12:101900050301');
    expect(Date.parse(task.startsAt)).toBe(NOW.getTime());
    expect(Date.parse(task.endsAt) - Date.parse(task.startsAt)).toBe(3600_000);
    expect(task.taskDocument.type).toBe('org.bioregion.event.attestation');
    expect(task.taskDocument.kind).toBe('meeting');
    expect(task.taskDocument.location).toMatchObject({ placeId: 'huc12:101900050301', name: 'Farmers market' });
    expect(task.taskDigest).toBe(digestMultibase(task.taskDocument));
    expect((await verifyDocument(task.taskDocument, resolver)).ok).toBe(true);
    expect(vwc12.issuer).toBe(POD_DID);
    expect(vwc12.credentialSubject['witnessedBy']).toBe(w.did);
    expect(vwc12.credentialSubject['edgeParties']).toEqual([p1.did, p2.did]);
    expect(vwc12.credentialSubject['taskContext']).toBe(task.id);
    expect(vwc12.credentialSubject['taskDigestMultibase']).toBe(task.taskDigest);
    expect((await verifyDocument(vwc12 as any, resolver)).ok).toBe(true);
    const stored = await run((ctx) => ctx.db.query('SELECT witness_tier FROM witness_refs WHERE digest = $1', [digestMultibase(vwc12)]));
    expect(stored[0].witness_tier).toBe('T2');
  });

  it('a pair is still witnessed once per pod: the same witness recovers it without a new meeting; others are refused', async () => {
    const count = async () => Number((await run((ctx) => ctx.db.query(`SELECT COUNT(*) AS n FROM events WHERE kind = 'meeting'`)))[0].n);
    const before = await count();
    const again = await call('POST', '/witness', { session: wSession, body: { vrcA: edge12.vrcB, vrcB: edge12.vrcA, evidence: 'liveness' } });
    expect(again.status).toBe(200);
    expect(again.body.existing).toBe(true);
    expect(again.body.task.id).toBe(task.id);
    expect(digestMultibase(again.body.vwc)).toBe(digestMultibase(vwc12));
    expect(await count()).toBe(before);
    const other = await call('POST', '/witness', { session: stewardSession, body: { vrcA: edge12.vrcA, vrcB: edge12.vrcB, evidence: 'liveness' } });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('ALREADY_WITNESSED');
    // And at a scheduled event too.
    const atEvent = await call('POST', `/events/${gathering.id}/witness`, { session: stewardSession, body: { vrcA: edge12.vrcA, vrcB: edge12.vrcB, evidence: 'same-event' } });
    expect(atEvent.status).toBe(409);
    expect(await count()).toBe(before);
  });

  it('refuses self-witness and a malformed pair at /witness', async () => {
    const own = relationship(w, p3);
    const self = await call('POST', '/witness', { session: wSession, body: { vrcA: own.vrcA, vrcB: own.vrcB, evidence: 'liveness' } });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_WITNESS');
    const half = await call('POST', '/witness', { session: wSession, body: { vrcA: own.vrcA, evidence: 'liveness' } });
    expect(half.status).toBe(400);
    expect(half.body.code).toBe('BAD_PAIR');
    const badPlace = await call('POST', '/witness', { session: wSession, body: { ...relationship(p3, p4), evidence: 'liveness', place: { lat: 200 } } });
    expect(badPlace.status).toBe(400);
    // No scheduled gathering, so no same-event evidence: the witness saw both people live.
    const sameEvent = await call('POST', '/witness', { session: wSession, body: { ...relationship(p3, p4), evidence: 'same-event' } });
    expect(sameEvent.status).toBe(400);
    expect(sameEvent.body.message).toMatch(/liveness/);
  });

  it('both parties apply with the meeting VWC and are admitted at T1', async () => {
    const a = await admit(p1, vwc12, edge12.both);
    const b = await admit(p2, vwc12, edge12.both, pT2);
    for (const r of [a, b]) {
      const actions = [...(r.vacs[0]!.credentialSubject['authority'].actions as string[])].sort();
      expect(actions).toEqual([...tierDefaultActions('T1')].sort());
    }
    expect(await memberRow(p1.did)).toMatchObject({ tier: 'T1', effective_tier: 'T1' });
    expect(await memberRow(p2.did)).toMatchObject({ tier: 'T1', effective_tier: 'T1' });
  });

  it('admission.witnessTier T3 refuses admission when the witness was T2 at witness time', async () => {
    const e = relationship(p3, p4);
    const res = await call('POST', '/witness', { session: wSession, body: { vrcA: e.vrcA, vrcB: e.vrcB, evidence: 'liveness' } });
    expect(res.status).toBe(201);
    const refused = await apply(p3, res.body.vwc, e.both, pT3);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('WITNESS_INVALID');
    expect(refused.body.message).toMatch(/T3/);
    // The tier recorded at witness time counts, not today's: promoting the witness later does not help.
    await run((ctx) => recordGovernanceTier(ctx, w.did, 'T3', 'operator', 'elected steward'));
    const still = await apply(p3, res.body.vwc, e.both, pT3);
    expect(still.status).toBe(403);
    await run((ctx) => recordGovernanceTier(ctx, w.did, 'T2', 'operator', 'term ended'));
    // Refs that predate migration 0011 carry 'legacy': for those only, the witness's CURRENT tier counts.
    const digest = digestMultibase(res.body.vwc);
    await run((ctx) => ctx.db.query(`UPDATE witness_refs SET witness_tier = 'legacy' WHERE digest = $1`, [digest]));
    expect((await apply(p3, res.body.vwc, e.both, pT3)).status).toBe(403);
    await run((ctx) => ctx.db.query(`UPDATE witness_refs SET witness_tier = 'T2' WHERE digest = $1`, [digest]));
    // Under a T2 (or unset) witness tier the same VWC admits.
    await admit(p3, res.body.vwc, e.both, pT2);
  });

  it('a T1 member without vwc:issue cannot witness', async () => {
    const e = relationship(generateKeyPair(), generateKeyPair());
    const res = await call('POST', '/witness', { session: sessionOf(p1.did, 'T1'), body: { vrcA: e.vrcA, vrcB: e.vrcB, evidence: 'liveness' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MISSING_AUTHORITY');
    // Even under a permissive policy T1 gains nothing.
    expect(tierActions({ policy: pT2 }, 'T1')).not.toContain('vwc:issue');
  });

  it('meetings are hidden from the public events list; stewards list them with ?kind=meeting', async () => {
    const pub = await call('GET', '/events');
    const ids = pub.body.events.map((e: any) => e.id) as string[];
    expect(ids).toContain(gathering.id);
    expect(ids.some((id) => id.startsWith('meet-'))).toBe(false);
    expect(pub.body.events.every((e: any) => e.kind === 'event')).toBe(true);
    const anon = await call('GET', '/events?kind=meeting');
    expect(anon.status).toBe(401);
    const member = await call('GET', '/events?kind=meeting', { session: wSession });
    expect(member.status).toBe(403);
    const st = await call('GET', '/events?kind=meeting', { session: stewardSession });
    expect(st.status).toBe(200);
    const meetings = st.body.events as any[];
    expect(meetings.map((e) => e.id)).toContain(task.id);
    expect(meetings.every((e) => e.kind === 'meeting')).toBe(true);
    expect((await call('GET', '/events?kind=party')).status).toBe(400);
    // A meeting is readable by id (a VWC names it as its task context), but only in summary for outsiders.
    const summary = { id: task.id, kind: 'meeting', startsAt: task.startsAt, endsAt: task.endsAt, taskDigest: task.taskDigest };
    expect((await call('GET', `/events/${task.id}`)).body).toEqual(summary);
    expect((await call('GET', `/events/${task.id}`, { session: sessionOf(p3.did, 'T1') })).body).toEqual(summary);
    // Full view: stewards, the witness (convener), and either party — even on a holder-only visitor session.
    for (const viewer of [stewardSession, wSession, sessionOf(p1.did, 'T1'), { subject: p2.did, tier: 'T0', authorities: [] } as unknown as SessionClaims]) {
      const full = await call('GET', `/events/${task.id}`, { session: viewer });
      expect(full.body.conveners).toEqual([w.did]);
      expect(full.body.taskDocument.kind).toBe('meeting');
    }
    // A steward session from another pod is an outsider here.
    expect((await call('GET', `/events/${task.id}`, { session: { ...stewardSession, pod: OTHER_POD } })).body).toEqual(summary);
    // Scheduled events stay fully public.
    expect((await call('GET', `/events/${gathering.id}`)).body.conveners).toEqual([steward.did]);
  });

  it('GET /steward/witnesses reports witness volume; witnessVolume windows by days', async () => {
    const res = await call('GET', '/steward/witnesses', { session: stewardSession });
    expect(res.status).toBe(200);
    const mine = res.body.witnesses.find((x: any) => x.witness === w.did);
    expect(mine).toMatchObject({ witness: w.did, pairs: 2, atMeetings: 2, atEvents: 0, admitted: 3 });
    const st = res.body.witnesses.find((x: any) => x.witness === steward.did);
    expect(st.atEvents).toBeGreaterThanOrEqual(1);
    expect((await call('GET', '/steward/witnesses', { session: wSession })).status).toBe(403);
    expect((await call('GET', '/steward/witnesses?sinceDays=-1', { session: stewardSession })).status).toBe(400);
    expect((await call('GET', '/steward/witnesses?sinceDays=36501', { session: stewardSession })).status).toBe(400);
    expect((await call('GET', '/steward/witnesses?sinceDays=36500', { session: stewardSession })).status).toBe(200);
    await expect(run((ctx) => witnessVolume(ctx, 40_000))).rejects.toThrow(/sinceDays/);
    const later = new Date(NOW.getTime() + 10 * DAY);
    const recent = await run((ctx) => witnessVolume(ctx, 5), later);
    expect(recent.find((x) => x.witness === w.did)).toBeUndefined();
    const wide = await run((ctx) => witnessVolume(ctx, 30), later);
    expect(wide.find((x) => x.witness === w.did)?.pairs).toBe(2);
  });

  it('records the witness tier with an expired effective tier ignored, and T0 for a non-member', async () => {
    const x = generateKeyPair();
    const a = generateKeyPair();
    const b = generateKeyPair();
    // Governance T1; a T3 effective tier that expired yesterday; a VAC that still carries vwc:issue.
    await run(async (ctx) => {
      await ctx.db.query(
        `INSERT INTO members (did, tier, effective_tier, effective_until, joined_at) VALUES ($1, 'T1', 'T3', $2, $3)`,
        [x.did, new Date(NOW.getTime() - DAY).toISOString(), NOW.toISOString()],
      );
      await issueAuthorities(ctx, deps, x.did, 'T3', ['test: stale steward']);
    });
    expect(await run((ctx) => currentTier(ctx, x.did))).toBe('T1');
    const e = relationship(a, b);
    const xSession = { subject: x.did, pod: POD_DID, tier: 'T3', authorities: tierDefaultActions('T3') } as SessionClaims;
    const res = await call('POST', '/witness', { session: xSession, body: { vrcA: e.vrcA, vrcB: e.vrcB, evidence: 'liveness' } });
    expect(res.status).toBe(201);
    const [ref] = await run((ctx) => ctx.db.query('SELECT witness_tier FROM witness_refs WHERE digest = $1', [digestMultibase(res.body.vwc)]));
    expect(ref.witness_tier).toBe('T1');
    const refused = await apply(a, res.body.vwc, e.both, pT2);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('WITNESS_INVALID');
    // While the effective tier is current it counts.
    await run((ctx) => ctx.db.query('UPDATE members SET effective_until = $2 WHERE did = $1', [x.did, new Date(NOW.getTime() + DAY).toISOString()]));
    expect(await run((ctx) => currentTier(ctx, x.did))).toBe('T3');
    // A session holder with no members row records T0, whatever the session claims.
    const stranger = generateKeyPair();
    const e2 = relationship(generateKeyPair(), generateKeyPair());
    const res2 = await call('POST', '/witness', {
      session: { subject: stranger.did, pod: POD_DID, tier: 'T3', authorities: ['vwc:issue'] } as SessionClaims,
      body: { vrcA: e2.vrcA, vrcB: e2.vrcB, evidence: 'liveness' },
    });
    expect(res2.status).toBe(201);
    const [ref2] = await run((ctx) => ctx.db.query('SELECT witness_tier FROM witness_refs WHERE digest = $1', [digestMultibase(res2.body.vwc)]));
    expect(ref2.witness_tier).toBe('T0');
    expect(await run((ctx) => currentTier(ctx, stranger.did))).toBe('T0');
  });

  it('a concurrent re-post by the same witness leaves no orphan meeting and returns the stored task', async () => {
    const e = relationship(generateKeyPair(), generateKeyPair());
    const first = await call('POST', '/witness', { session: wSession, body: { vrcA: e.vrcA, vrcB: e.vrcB, evidence: 'liveness' } });
    expect(first.status).toBe(201);
    const meetings = async () => Number((await run((ctx) => ctx.db.query(`SELECT COUNT(*) AS n FROM events WHERE kind = 'meeting'`)))[0].n);
    const before = await meetings();
    // Simulate the race: this request's pre-check runs before the other request's witness_refs row is visible.
    const out = await run(async (ctx) => {
      let hidden = false;
      const racing: Db = Object.create(ctx.db);
      racing.query = (async (text: string, params?: unknown[]) => {
        if (!hidden && text.startsWith('SELECT digest, convener_did FROM witness_refs')) {
          hidden = true;
          return [];
        }
        return ctx.db.query(text, params);
      }) as Db['query'];
      return witnessMeeting({ ...ctx, db: racing }, deps, w.did, { vrcA: e.vrcB, vrcB: e.vrcA, evidence: 'liveness' });
    });
    expect(out.existing).toBe(true);
    expect(out.task.id).toBe(first.body.task.id);
    expect(digestMultibase(out.vwc)).toBe(digestMultibase(first.body.vwc));
    expect(await meetings()).toBe(before);
  });

  it('events.kind is constrained to event or meeting', async () => {
    await expect(
      run((ctx) => ctx.db.query(`INSERT INTO events (id, title, kind) VALUES ('evt_badkind', 'x', 'party')`)),
    ).rejects.toThrow();
    const [row] = await run((ctx) => ctx.db.query(`INSERT INTO events (id, title) VALUES ('evt_defaultkind', 'x') RETURNING kind`));
    expect(row.kind).toBe('event');
    await run((ctx) => ctx.db.query(`DELETE FROM events WHERE id = 'evt_defaultkind'`));
  });

  it('with immediate downgrades, a VAC carrying actions its tier no longer grants is revoked and re-issued', async () => {
    const immediate = { ...policy, downgradeAtExpiryOnly: false } as TrustPolicy;
    const before = await run((ctx) => validVacs(ctx, w.did));
    const withWitness = before.filter((r: any) => JSON.stringify(r.actions).includes('vwc:issue'));
    expect(withWitness.length).toBeGreaterThan(0);
    // At-expiry policy (the default) keeps it until it expires.
    const lazy = await call('POST', '/authority/refresh', { session: wSession });
    expect(lazy.body.vacs.some((c: any) => c.credentialSubject.authority.actions.includes('vwc:issue'))).toBe(true);
    // Leave only the VAC with vwc:issue valid, so the refresh must re-issue after revoking it.
    const plainIds = before.filter((r: any) => !withWitness.includes(r)).map((r: any) => r.id);
    if (plainIds.length) {
      await run((ctx) => ctx.db.query('UPDATE vac_issuance_log SET revoked_at = $2 WHERE id = ANY($1::bigint[])', [plainIds, NOW.toISOString()]));
    }
    const res = await call('POST', '/authority/refresh', { session: wSession, policy: immediate });
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('T2');
    expect(res.body.issued).toBe(true);
    expect(res.body.vacs).toHaveLength(1);
    for (const c of res.body.vacs) expect(c.credentialSubject.authority.actions).not.toContain('vwc:issue');
    expect(res.body.explanation.join(' ')).toMatch(/no longer grants/);
    const revoked = await run((ctx) => ctx.db.query('SELECT revoked_at FROM vac_issuance_log WHERE id = $1', [withWitness[0]!.id]));
    expect(revoked[0].revoked_at).not.toBeNull();
  });
});

