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
import { ChallengeStore } from './challenges.js';
import { createPodVtaRoutes } from './routes.js';
import { RelayStore } from './relay.js';
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
    challenges: new ChallengeStore(),
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

describe('pod VTA — ceremony back half', () => {
  const steward = generateKeyPair();
  const alice = generateKeyPair();
  const bob = generateKeyPair();
  const stewardSession = sessionOf(steward.did, 'T3');
  let event: any;
  let vrcHeldByAlice: VerifiableCredential;
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

  it('refuses event creation without event:convene', async () => {
    const res = await call('POST', '/events', { session: sessionOf(alice.did, 'T1'), body: { title: 'x', startsAt: NOW.toISOString(), endsAt: new Date(NOW.getTime() + DAY).toISOString() } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MISSING_AUTHORITY');
  });

  it('two personas form a VRC pair and a VEC; the steward witnesses the edge', async () => {
    const formedAt = NOW.toISOString();
    const vrcA = signDocument(buildRelationship({ issuer: alice.did, subject: bob.did, bioregion: SLUG, formedAt, validFrom: formedAt }), alice);
    const vrcB = signDocument(buildRelationship({ issuer: bob.did, subject: alice.did, bioregion: SLUG, formedAt, validFrom: formedAt }), bob);
    const vec = signDocument(buildEndorsement({ issuer: bob.did, subject: alice.did, scope: 'lives-here', validFrom: formedAt }), bob);
    expect((await verifyDocument(vec, resolver)).ok).toBe(true);
    vrcHeldByAlice = vrcB;
    const edgeDigest = digestMultibase([vrcA, vrcB].map((v) => digestMultibase(v)).sort());

    const notConvener = await call('POST', `/events/${event.id}/witness`, { session: sessionOf(bob.did, 'T3'), body: { edgeDigest, evidence: 'same-event' } });
    expect(notConvener.status).toBe(403);
    expect(notConvener.body.code).toBe('NOT_CONVENER');

    const res = await call('POST', `/events/${event.id}/witness`, { session: stewardSession, body: { edgeDigest, evidence: 'same-event', subject: alice.did } });
    expect(res.status).toBe(201);
    vwc = res.body.vwc;
    expect(vwc.issuer).toBe(POD_DID);
    expect(vwc.credentialSubject['witnessedBy']).toBe(steward.did);
    expect(vwc.credentialSubject['taskContext']).toBe(event.id);
    expect(vwc.credentialSubject['taskDigestMultibase']).toBe(event.taskDigest);
    expect(Date.parse(vwc.validUntil!) - Date.parse(vwc.validFrom)).toBe(365 * DAY);
    expect((await verifyDocument(vwc as any, resolver)).ok).toBe(true);
  });

  it('applies with a VP bound to a fresh challenge and receives a signed grant (idempotently)', async () => {
    const c = await challenge();
    expect(c.domain).toBe(`${SLUG}.${DOMAIN}`);
    const presentation = createPresentation([vrcHeldByAlice], alice, c);
    const res = await call('POST', '/membership/apply', { body: { vwc, presentation } });
    expect(res.status).toBe(201);
    grant = res.body.grant;
    expect(grant.issuer).toBe(POD_DID);
    expect(grant.credentialSubject.id).toBe(alice.did);
    expect(grant.credentialSubject['placeIds']).toEqual(['huc12:101900050301']);
    expect(Date.parse(grant.validUntil!) - Date.parse(grant.validFrom)).toBe(90 * DAY);

    const again = await call('POST', '/membership/apply', { body: { vwc, presentation: createPresentation([], alice, await challenge()) } });
    expect(again.status).toBe(200);
    expect(digestMultibase(again.body.grant)).toBe(digestMultibase(grant));
  });

  it('refuses an application whose challenge was already used', async () => {
    const c = await challenge();
    const presentation = createPresentation([], alice, c);
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

    const log = await call('GET', '/steward/vac-log', { session: stewardSession });
    expect(log.body.entries.some((e: any) => e.subject === alice.did && e.tier === 'T1')).toBe(true);
    const members = await call('GET', '/steward/members', { session: stewardSession });
    expect(members.body.members.find((m: any) => m.did === alice.did)).toMatchObject({ tier: 'T1', status: 'member' });
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
    const members = await call('POST', '/session', { body: { presentation: createPresentation([], bob, await challenge()) } });
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
    const res = await call('POST', '/membership/apply', { body: { vwc: foreign, presentation: createPresentation([], carol, await challenge()) } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WITNESS_INVALID');
    expect(res.body.message).toBe("Admission needs a witness credential from one of this pod's attestation events.");
  });

  it('refuses a presentation with a bad proof', async () => {
    const c = await challenge();
    const vp = createPresentation([], alice, c);
    const tampered = { ...vp, holder: bob.did };
    const res = await call('POST', '/membership/apply', { body: { vwc, presentation: tampered } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_PROOF');
  });

  it('refresh never lowers a tier before the VAC expires; the recommendation applies after expiry', async () => {
    // The index recommends T1 for the steward (mocked: the real index reads members.tier as the governance record).
    const toT1 = createPodVtaRoutes({ ...deps, index: { recommendTier: async () => ({ tier: 'T1', explanation: ['mocked T1'] }) } });
    const s = sessionOf(steward.did, 'T3');
    const early = await call('POST', '/authority/refresh', { session: s, routes: toT1 });
    expect(early.status).toBe(200);
    expect(early.body.tier).toBe('T3');
    expect(early.body.explanation.join(' ')).toMatch(/stays at T3 until/);
    // The pending downgrade gets its T1 VAC now; the T3 VAC stays valid until it expires.
    expect(early.body.vacs.map((v: any) => v.credentialSubject.tier).sort()).toEqual(['T1', 'T3']);
    let rows = await run((ctx) => ctx.db.query('SELECT tier FROM members WHERE did = $1', [steward.did]));
    expect(rows[0].tier).toBe('T3');

    const again = await call('POST', '/authority/refresh', { session: s, routes: toT1, now: new Date(NOW.getTime() + 30 * DAY) });
    expect(again.body.tier).toBe('T3');
    expect(again.body.issued).toBe(false);

    const later = new Date(NOW.getTime() + 91 * DAY);
    const expired = await call('POST', '/authority/refresh', { session: s, routes: toT1, now: later });
    expect(expired.body.tier).toBe('T1');
    expect(expired.body.vacs.map((v: any) => v.credentialSubject.tier)).toEqual(['T1']);
    rows = await run((ctx) => ctx.db.query('SELECT tier FROM members WHERE did = $1', [steward.did]));
    expect(rows[0].tier).toBe('T1');

    // With the real index: Alice has no witnessed postings of her own yet, but her T1 VAC is valid.
    const aliceEarly = await call('POST', '/authority/refresh', { session: sessionOf(alice.did, 'T1') });
    expect(aliceEarly.status).toBe(200);
    expect(aliceEarly.body.tier).toBe('T1');
    expect(aliceEarly.body.vacs.length).toBeGreaterThanOrEqual(1);

    // Restore the steward for the steward-only tests below.
    await run((ctx) => bootstrapSteward(ctx, deps, steward.did));
  });

  it('refresh upgrades at once and renews a VAC that is about to expire', async () => {
    const mocked = createPodVtaRoutes({ ...deps, index: { recommendTier: async () => ({ tier: 'T2', explanation: ['mocked T2'] }) } });
    const up = await call('POST', '/authority/refresh', { session: sessionOf(alice.did, 'T1'), routes: mocked });
    expect(up.body.tier).toBe('T2');
    expect(up.body.issued).toBe(true);
    expect(up.body.vacs[0].credentialSubject.authority.actions).toEqual(tierDefaultActions('T2'));
    const same = await call('POST', '/authority/refresh', { session: sessionOf(alice.did, 'T2'), routes: mocked });
    expect(same.body.issued).toBe(false);
    const nearExpiry = await call('POST', '/authority/refresh', { session: sessionOf(alice.did, 'T2'), routes: mocked, now: new Date(NOW.getTime() + 85 * DAY) });
    expect(nearExpiry.body.issued).toBe(true);
    expect(nearExpiry.body.tier).toBe('T2');
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

  it('files and adjudicates a dispute with a pod-signed adjudication', async () => {
    const filed = await call('POST', '/disputes', { session: sessionOf(alice.did, 'T1'), body: { subjectDigest: digestMultibase(vwc), reason: 'I was not there' } });
    expect(filed.status).toBe(201);
    expect(filed.body.status).toBe('open');
    const list = await call('GET', '/steward/disputes', { session: stewardSession });
    expect(list.body.disputes.map((d: any) => d.id)).toContain(filed.body.id);
    const done = await call('POST', `/steward/disputes/${filed.body.id}/adjudicate`, { session: stewardSession, body: { outcome: 'upheld', subjectDid: alice.did } });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('adjudicated');
    const adj = done.body.adjudication;
    expect(adj.issuer).toBe(POD_DID);
    expect(adj.credentialSubject.adjudicatedBy).toBe(steward.did);
    expect(adj.credentialSubject.predicate).toBe('bioregion:adjudicated');
    expect((await verifyDocument(adj, resolver)).ok).toBe(true);
    const noAuth = await call('GET', '/steward/disputes', { session: sessionOf(alice.did, 'T1') });
    expect(noAuth.status).toBe(403);
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
  it('are single-use and scoped to the pod', () => {
    const store = new ChallengeStore();
    const c = store.issue('boulder', 'boulder.x', NOW);
    expect(() => store.consume('tenant-zero', c.challenge, NOW)).toThrow(/not issued by this pod/);
    const c2 = store.issue('boulder', 'boulder.x', NOW);
    expect(store.consume('boulder', c2.challenge, NOW)).toEqual({ challenge: c2.challenge, domain: 'boulder.x' });
    expect(() => store.consume('boulder', c2.challenge, NOW)).toThrow(/already been used/);
    const c3 = store.issue('boulder', 'boulder.x', NOW);
    expect(() => store.consume('boulder', c3.challenge, new Date(NOW.getTime() + 5 * 60_000))).toThrow(/expired/);
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
  }

  it('appends and lists in order with a 24 h cutoff (in-memory ring)', async () => {
    await exercise({ routes: createPodVtaRoutes({ ...deps, relay: new RelayStore() }) });
  });

  it('appends and lists in order with a 24 h cutoff (platform.relay_messages)', async () => {
    await exercise({ routes: createPodVtaRoutes({ ...deps, platformDb: db }), unscoped: true });
    const rows = await db.query('SELECT channel FROM platform.relay_messages LIMIT 1');
    expect(rows[0].channel).toBe(`${SLUG}:${channel}`);
  });
});

describe('pod VTA — in-process smoke', () => {
  it('ceremonyBackHalf runs witness → apply → ack → VACs with the control plane helpers', async () => {
    const res = await run((ctx) => ceremonyBackHalf(ctx, { signer: podSigner, resolver }));
    expect(res.ok).toBe(true);
    expect(res.vacs[0]!.credentialSubject['authority'].actions).toEqual(tierDefaultActions('T1'));
    expect(res.ack.credentialSubject['digestMultibase']).toBe(digestMultibase(res.grant));
  });

  it('ceremonyBackHalf accepts an explicit convener session, applicant key and event', async () => {
    const convener = generateKeyPair();
    await run((ctx) => bootstrapSteward(ctx, deps, convener.did));
    const session = sessionOf(convener.did, 'T3');
    const event = await newEvent(session);
    const applicantKey = generateKeyPair();
    const res = await run((ctx) => ceremonyBackHalf(ctx, deps, { convenerSession: session, applicantKey, event }));
    expect(res.member).toBe(applicantKey.did);
    expect(res.eventId).toBe(event.id);
  });
});
