import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildMembershipAck,
  createResolver,
  didWebDocument,
  digestMultibase,
  generateKeyPair,
  keyPairForDid,
  signDocument,
  type VerifiableCredential,
} from '@passport/credential-core';
import { createTestDb, createTestPod, withPod, type Db } from '@passport/db';
import { acknowledgeMembership, type PodSigner, type VtaContext } from '@passport/pod-vta';
import type { SessionClaims } from '@passport/service-kit';
import { boulderManifest, defaultTrustPolicy } from '@passport/tenant-config';
import { tierDefaultActions } from '@passport/vocab';
import type { MountDeps } from '../../../../lib/mount';
import { BOOTSTRAP_MOUNT, mountBootstrapSteward } from './bootstrapSteward';

const DOMAIN = 'bioregionalpassport.org';
const POD_DID = boulderManifest.identity.did;
const NOW = new Date('2026-09-22T12:00:00Z');
const TOKEN = 'operator-token-for-tests';
const podKey = keyPairForDid(POD_DID, generateKeyPair().privateKey);
const podSigner: PodSigner = { did: podKey.did, kid: podKey.kid, keyPair: podKey, sign: (doc, opts) => signDocument(doc, podKey, opts) };
const resolver = createResolver({ staticDocs: { [POD_DID]: didWebDocument(POD_DID, podKey.publicKeyMultibase) } });
const policy = defaultTrustPolicy(POD_DID);

const SESSIONS: Record<string, SessionClaims> = {
  steward: { subject: 'did:key:zSteward', pod: POD_DID, tier: 'T3', authorities: ['pep:review', 'registry:propose'] },
};

let db: Db;
let svc: ReturnType<typeof mountBootstrapSteward>;

const pod = { slug: 'boulder', did: POD_DID, manifest: boulderManifest, policy, status: 'active' };

function mountDeps(): MountDeps {
  return {
    platformDomain: DOMAIN,
    operatorToken: TOKEN,
    secureCookies: true,
    findPod: async (slug) => (slug === 'boulder' ? pod : null),
    withPod: (slug, fn) => withPod(db, slug, fn),
    platformDb: () => db,
    readSession: async (token) => SESSIONS[token] ?? null,
    now: () => NOW,
    logError: () => {},
  };
}

function call(slug: string, body: unknown, init: { token?: string; cookie?: string; method?: 'POST' | 'GET' } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers['authorization'] = `Bearer ${init.token}`;
  if (init.cookie) headers['cookie'] = `passport_session=${init.cookie}`;
  const method = init.method ?? 'POST';
  const req = new Request(`https://${DOMAIN}/api/control/pods/${slug}/bootstrap-steward`, {
    method,
    headers,
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  return svc[method](req);
}

const ctxFor = (tx: Db): VtaContext => ({ slug: 'boulder', podDid: POD_DID, db: tx, manifest: boulderManifest, policy, now: () => NOW, platformDomain: DOMAIN });

beforeAll(async () => {
  db = await createTestDb();
  await createTestPod(db, 'boulder');
  svc = mountBootstrapSteward(
    { findPod: async (slug) => (slug === 'boulder' ? pod : null), withPod: (slug, fn) => withPod(db, slug, fn), loadSigner: async () => podSigner },
    mountDeps(),
  );
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('POST /api/control/pods/:slug/bootstrap-steward', () => {
  it('mounts on the platform scope', () => {
    expect(BOOTSTRAP_MOUNT).toEqual({ base: '/api/control', scope: 'platform' });
  });

  it('is operator-only (Bearer key; a pod steward session is not enough)', async () => {
    const did = generateKeyPair().did;
    expect((await call('boulder', { did })).status).toBe(401);
    const steward = await call('boulder', { did }, { cookie: 'steward' });
    expect(steward.status).toBe(403);
    expect((await steward.json()).code).toBe('OPERATOR_ONLY');
    expect((await call('boulder', { did }, { token: 'wrong' })).status).toBe(403);
    expect((await call('boulder', { did }, { token: TOKEN, method: 'GET' })).status).toBe(405);
  });

  it('validates the DID and the pod', async () => {
    const bad = await call('boulder', { did: 'not a did' }, { token: TOKEN });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('BAD_REQUEST');
    const missing = await call('nowhere', { did: generateKeyPair().did }, { token: TOKEN });
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('POD_NOT_FOUND');
  });

  it('bootstraps T3, returns a pod-signed grant and T3 VACs, and the wallet ack completes the pair at T3', async () => {
    const steward = generateKeyPair();
    const res = await call('boulder', { did: steward.did, name: 'Ada' }, { token: TOKEN });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { member: { did: string; tier: string; name?: string }; grant: VerifiableCredential; vacs: VerifiableCredential[] };
    expect(out.member).toEqual({ did: steward.did, tier: 'T3', name: 'Ada' });
    expect(out.grant.type).toContain('MembershipCredential');
    expect(out.grant.issuer).toBe(POD_DID);
    expect(out.grant.credentialSubject.id).toBe(steward.did);
    expect(out.grant.credentialSubject['digestMultibase']).toBeUndefined();
    expect(out.grant.proof).toBeTruthy();
    expect(Date.parse(out.grant.validUntil!) - NOW.getTime()).toBeLessThanOrEqual(policy.grantValidityDays * 86_400_000);
    expect(out.vacs.length).toBeGreaterThan(0);
    const actions = out.vacs[0]!.credentialSubject['authority']?.actions as string[];
    expect([...actions].sort()).toEqual([...tierDefaultActions('T3')].sort());

    const [row] = await withPod(db, 'boulder', (tx) =>
      tx.query<{ tier: string; effective_tier: string; vmc_grant_digest: string; ack: unknown }>('SELECT tier, effective_tier, vmc_grant_digest, ack FROM members WHERE did = $1', [steward.did]),
    );
    expect(row).toMatchObject({ tier: 'T3', effective_tier: 'T3', vmc_grant_digest: digestMultibase(out.grant), ack: null });

    // A repeated bootstrap hands back the same pending grant.
    const again = await (await call('boulder', { did: steward.did }, { token: TOKEN })).json();
    expect(digestMultibase(again.grant)).toBe(digestMultibase(out.grant));

    // What the wallet's consent screen does: sign the ack with the grant's window and post it.
    const ack = signDocument(
      buildMembershipAck({ member: steward.did, pod: POD_DID, grantDigest: digestMultibase(out.grant), validFrom: out.grant.validFrom, validUntil: out.grant.validUntil! }),
      steward,
      { created: NOW.toISOString() },
    );
    const acked = await withPod(db, 'boulder', (tx) => acknowledgeMembership(ctxFor(tx), { podSigner, resolver }, { ack }));
    expect(acked.member.tier).toBe('T3');
    const [after] = await withPod(db, 'boulder', (tx) =>
      tx.query<{ tier: string; effective_tier: string; vmc_ack_digest: string | null }>('SELECT tier, effective_tier, vmc_ack_digest FROM members WHERE did = $1', [steward.did]),
    );
    expect(after).toMatchObject({ tier: 'T3', effective_tier: 'T3' });
    expect(after!.vmc_ack_digest).toBe(digestMultibase(ack));
  }, 30_000);
});
