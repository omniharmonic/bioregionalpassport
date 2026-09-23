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
import { issueAuthorities } from './pep.js';
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
const policy: TrustPolicy = defaultTrustPolicy(POD_DID);

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
    return opts.unscoped ? exec(ctxFor(db, opts.now ?? NOW)) : run(exec, opts.now ?? NOW);
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

/** A signed VRC pair between two personas; the edge digest is the digest of `a`'s half. */
function relationship(a: KeyPair, b: KeyPair) {
  const formedAt = NOW.toISOString();
  const vrcA = signDocument(buildRelationship({ issuer: a.did, subject: b.did, bioregion: SLUG, formedAt, validFrom: formedAt }), a);
  const vrcB = signDocument(buildRelationship({ issuer: b.did, subject: a.did, bioregion: SLUG, formedAt, validFrom: formedAt }), b);
  return { vrcA, vrcB, edgeDigest: digestMultibase(vrcA), edgeParties: [a.did, b.did] };
}

async function witness(session: SessionClaims, eventId: string, edge: { edgeDigest: string; edgeParties: string[] }, extra: Record<string, unknown> = {}) {
  const res = await call('POST', `/events/${eventId}/witness`, { session, body: { edgeDigest: edge.edgeDigest, edgeParties: edge.edgeParties, evidence: 'same-event', ...extra } });
  expect(res.status).toBe(201);
  return res.body.vwc as VerifiableCredential;
}

async function apply(key: KeyPair, vwc: unknown, creds: VerifiableCredential[]) {
  return call('POST', '/membership/apply', { body: { vwc, presentation: createPresentation(creds, key, await challenge()) } });
}

async function admit(key: KeyPair, vwc: unknown, creds: VerifiableCredential[]) {
  const res = await apply(key, vwc, creds);
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

    const notConvener = await call('POST', `/events/${event.id}/witness`, { session: sessionOf(bob.did, 'T3'), body: { edgeDigest: edge.edgeDigest, edgeParties: edge.edgeParties, evidence: 'same-event' } });
    expect(notConvener.status).toBe(403);
    expect(notConvener.body.code).toBe('NOT_CONVENER');
    const noParties = await call('POST', `/events/${event.id}/witness`, { session: stewardSession, body: { edgeDigest: edge.edgeDigest, evidence: 'same-event' } });
    expect(noParties.status).toBe(400);

    vwc = await witness(stewardSession, event.id, edge);
    expect(vwc.issuer).toBe(POD_DID);
    expect(vwc.credentialSubject['witnessedBy']).toBe(steward.did);
    expect(vwc.credentialSubject['edgeParties']).toEqual([alice.did, bob.did]);
    expect(vwc.credentialSubject['taskContext']).toBe(event.id);
    expect(vwc.credentialSubject['taskDigestMultibase']).toBe(event.taskDigest);
    expect(Date.parse(vwc.validUntil!) - Date.parse(vwc.validFrom)).toBe(365 * DAY);
    expect((await verifyDocument(vwc as any, resolver)).ok).toBe(true);
  });

  it('refuses the VWC to three unrelated DIDs replaying it (EDGE_NOT_YOURS)', async () => {
    for (const _ of [1, 2, 3]) {
      const stranger = generateKeyPair();
      const own = relationship(stranger, generateKeyPair());
      const res = await apply(stranger, vwc, [edge.vrcA, edge.vrcB, own.vrcA]);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('EDGE_NOT_YOURS');
      expect(res.body.message).toBe('This witness credential is for a relationship you are not part of.');
    }
  });

  it('applies with a VP bound to a fresh challenge and receives a signed grant (idempotently)', async () => {
    const c = await challenge();
    expect(c.domain).toBe(`${SLUG}.${DOMAIN}`);
    const res = await call('POST', '/membership/apply', { body: { vwc, presentation: createPresentation([edge.vrcA], alice, c) } });
    expect(res.status).toBe(201);
    grant = res.body.grant;
    expect(grant.issuer).toBe(POD_DID);
    expect(grant.credentialSubject.id).toBe(alice.did);
    expect(grant.credentialSubject['placeIds']).toEqual(['huc12:101900050301']);
    expect(Date.parse(grant.validUntil!) - Date.parse(grant.validFrom)).toBe(90 * DAY);

    const again = await apply(alice, vwc, [edge.vrcA]);
    expect(again.status).toBe(200);
    expect(digestMultibase(again.body.grant)).toBe(digestMultibase(grant));
  });

  it('refuses an application whose challenge was already used', async () => {
    const presentation = createPresentation([edge.vrcA], alice, await challenge());
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
    const bobDone = await admit(bob, vwc, [edge.vrcA]);
    expect(bobDone.vacs[0]!.credentialSubject.id).toBe(bob.did);
    const ref = await run(async (ctx) => (await ctx.db.query('SELECT used_by FROM witness_refs WHERE digest = $1', [digestMultibase(vwc)]))[0]);
    expect([...ref.used_by].sort()).toEqual([alice.did, bob.did].sort());
    const carol = generateKeyPair();
    const third = await apply(carol, vwc, [edge.vrcA]);
    expect(third.status).toBe(403);
    expect(third.body.code).toBe('EDGE_NOT_YOURS');
  });

  it('refuses a VWC that has already admitted two people (WITNESS_USED)', async () => {
    const dan = generateKeyPair();
    const erin = generateKeyPair();
    const e2 = relationship(dan, erin);
    const v2 = await witness(stewardSession, event.id, e2);
    await run((ctx) => ctx.db.query(`UPDATE witness_refs SET used_by = '["did:key:zX","did:key:zY"]'::jsonb WHERE digest = $1`, [digestMultibase(v2)]));
    const res = await apply(dan, v2, [e2.vrcA]);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WITNESS_USED');
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
    const res = await apply(fay, v3, [e3.vrcA]);
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
    const vp = createPresentation([edge.vrcA], alice, await challenge());
    const res = await call('POST', '/membership/apply', { body: { vwc, presentation: { ...vp, holder: bob.did } } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_PROOF');
  });

  it('a governance demotion sticks: effective tier holds until the VAC expires, then follows governance', async () => {
    const x = generateKeyPair();
    await run((ctx) => bootstrapSteward(ctx, deps, x.did));
    const demote = await call('POST', `/steward/members/${encodeURIComponent(x.did)}/tier`, { session: stewardSession, body: { tier: 'T1', reason: 'term ended' } });
    expect(demote.status).toBe(200);
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
    const vrc = signDocument(buildRelationship({ issuer: bob.did, subject: peer.did, bioregion: SLUG, formedAt: at, validFrom: at }), bob);
    const w = await call('POST', `/events/${ev.body.id}/witness`, {
      session: stewardSession,
      now: later,
      body: { edgeDigest: digestMultibase(vrc), edgeParties: [bob.did, peer.did], evidence: 'same-event' },
    });
    expect(w.status).toBe(201);
    const c = await challenge(later);
    const applied = await call('POST', '/membership/apply', { now: later, body: { vwc: w.body.vwc, presentation: createPresentation([vrc], bob, c) } });
    expect(applied.status).toBe(201);
    const g = applied.body.grant as VerifiableCredential;
    const a = signDocument(buildMembershipAck({ member: bob.did, pod: POD_DID, grantDigest: digestMultibase(g), validFrom: at, validUntil: g.validUntil! }), bob);
    const done = await call('POST', '/membership/ack', { now: later, body: { ack: a } });
    expect(done.status).toBe(200);
    expect(done.body.member.tier).toBe('T1');
    expect(done.body.vacs[0].credentialSubject.tier).toBe('T1');
    expect(await memberRow(bob.did)).toMatchObject({ tier: 'T1', effective_tier: 'T1' });
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
