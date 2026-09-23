import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createResolver, verifyDocument } from '@passport/credential-core';
import { createTestDb, listPods, withPod, type Db } from '@passport/db';
import { boulderManifest, tenantZeroManifest } from '@passport/tenant-config';
import {
  createControlRoutes,
  createRegistryRoutes,
  didDocumentFor,
  exportPod,
  getPod,
  listPodCards,
  loadPodSigner,
  provisionPod,
  tenantZeroJob,
  verifyPod,
  type PlatformContext,
} from './index.js';

const DOMAIN = 'bioregionalpassport.org';
const MASTER = '11'.repeat(32);
const OTHER = '22'.repeat(32);

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  await db.close();
});

const provision = (manifest: unknown, masterKey = MASTER) => provisionPod({ manifest, db, platformDomain: DOMAIN, masterKey });

function route(routes: ReturnType<typeof createRegistryRoutes>, method: string, path: string) {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`no route ${method} ${path}`);
  return r;
}

describe('provisionPod', () => {
  it('is idempotent: same DID and every step unchanged on the second run', async () => {
    const first = await provision(tenantZeroManifest);
    expect(first.did).toBe('did:web:bioregionalpassport.org:dids:tenant-zero');
    expect(first.steps.map((s) => s.name)).toEqual([
      'validate',
      'pod-key',
      'did-document',
      'schema',
      'trust-policy',
      'manifest',
      'registry',
      'seed-records',
    ]);
    expect(first.steps.find((s) => s.name === 'pod-key')?.status).toBe('created');
    const second = await provision(tenantZeroManifest);
    expect(second.did).toBe(first.did);
    expect(second.steps.every((s) => s.status === 'unchanged')).toBe(true);
    expect(second.manifest).toEqual(first.manifest);
    const keys = await db.query('select * from platform.pod_keys where slug = $1', ['tenant-zero']);
    expect(keys).toHaveLength(1);
  });

  it('provisions boulder alongside tenant zero with isolated schemas', async () => {
    await provision(tenantZeroManifest);
    const b = await provision(boulderManifest);
    expect((await listPods(db)).map((p) => p.slug)).toEqual(['boulder', 'tenant-zero']);
    await withPod(db, 'boulder', (tx) => tx.query("insert into records (uri, collection, bioregion, record) values ('at://boulder/x/1', 'x', 'boulder', '{}')"));
    const tz = await withPod(db, 'tenant-zero', (tx) => tx.query('select * from records'));
    const bo = await withPod(db, 'boulder', (tx) => tx.query('select * from records'));
    expect(tz).toHaveLength(0);
    expect(bo).toHaveLength(1);
    const bPolicy = (await getPod(db, 'boulder'))?.policy;
    const tPolicy = (await getPod(db, 'tenant-zero'))?.policy;
    expect(bPolicy?.pod).toBe(b.did);
    expect(tPolicy?.pod).not.toBe(b.did);
    const cards = await listPodCards(db);
    expect(cards.map((c) => c.slug)).toEqual(['boulder', 'tenant-zero']);
    expect(cards[0]).toMatchObject({ $type: 'org.bioregion.pod', manifestUrl: 'https://boulder.bioregionalpassport.org/.well-known/bioregion.json' });
  });

  it('overrides a foreign identity.did and signs a manifest that verifies against the DID document', async () => {
    const res = await provision({ ...boulderManifest, identity: { ...boulderManifest.identity, did: 'did:web:elsewhere.example' } });
    expect(res.steps[0]?.detail).toMatch(/replaced/);
    expect(res.manifest.identity.did).toBe(res.did);
    expect(res.manifest.trustPolicy).toBe('https://boulder.bioregionalpassport.org/api/vta/policy');
    const doc = await didDocumentFor(db, 'boulder', DOMAIN);
    expect(doc?.service?.[0]).toMatchObject({ id: `${res.did}#manifest`, type: 'BioregionManifest' });
    const resolver = createResolver({ staticDocs: { [res.did]: doc! } });
    const v = await verifyDocument(res.manifest as any, resolver);
    expect(v).toMatchObject({ ok: true, controller: res.did });
    const pod = await getPod(db, 'boulder');
    expect((await verifyDocument(pod!.policy as any, resolver)).ok).toBe(true);
  });

  it('re-signs and reports updated when the manifest changes', async () => {
    await provision(boulderManifest);
    const changed = { ...boulderManifest, theme: { ...boulderManifest.theme, tone: 'civic' as const } };
    const res = await provision(changed);
    expect(res.steps.find((s) => s.name === 'manifest')?.status).toBe('updated');
    expect(res.manifest.theme.tone).toBe('civic');
  });

  it('rejects an invalid manifest', async () => {
    await expect(provision({ identity: { slug: 'x' } })).rejects.toMatchObject({ code: 'INVALID_MANIFEST', status: 400 });
  });
});

describe('pod keys', () => {
  it('loadPodSigner decrypts the key and signs a document that verifies', async () => {
    const res = await provision(tenantZeroManifest);
    const signer = await loadPodSigner(db, 'tenant-zero', MASTER);
    expect(signer.did).toBe(res.did);
    const signed = signer.sign({ hello: 'world' });
    const doc = await didDocumentFor(db, 'tenant-zero', DOMAIN);
    const v = await verifyDocument(signed, createResolver({ staticDocs: { [res.did]: doc! } }));
    expect(v.ok).toBe(true);
    const row = (await db.query('select encrypted_private_key from platform.pod_keys'))[0];
    expect(row.encrypted_private_key).toMatch(/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  });

  it('fails clearly with the wrong master key', async () => {
    await provision(tenantZeroManifest);
    await expect(loadPodSigner(db, 'tenant-zero', OTHER)).rejects.toThrow(/POD_KEY_ENCRYPTION_KEY does not match/);
    await expect(provision(tenantZeroManifest, OTHER)).rejects.toThrow(/POD_KEY_ENCRYPTION_KEY does not match/);
    await expect(loadPodSigner(db, 'tenant-zero', 'short')).rejects.toThrow(/64 hex/);
  });
});

describe('registry routes', () => {
  it('authorizes a registered pod DID and refuses unknown DIDs', async () => {
    const res = await provision({ ...boulderManifest, governance: { ...boulderManifest.governance, anchors: ['did:key:zAnchor'] } });
    const ctx: PlatformContext = { db, platformDomain: DOMAIN };
    const routes = createRegistryRoutes();
    expect(routes.every((r) => r.auth === 'none')).toBe(true);
    const authz = route(routes, 'GET', '/authorization');
    const ok = await authz.handler(ctx, { params: {}, query: { entity: res.did, authority: 'issue:MembershipCredential' }, body: undefined });
    expect(ok.body.authorized).toBe(true);
    const unknown = await authz.handler(ctx, { params: {}, query: { entity: 'did:web:nope.example', authority: 'issue:MembershipCredential' }, body: undefined });
    expect(unknown.body).toMatchObject({ authorized: false });
    expect(unknown.body.reason).toMatch(/not a registered pod/);
    const anchor = await authz.handler(ctx, { params: {}, query: { entity: 'did:key:zAnchor', authority: 'anchor', context: res.did }, body: undefined });
    expect(anchor.body.authorized).toBe(true);
    const badAuthority = await authz.handler(ctx, { params: {}, query: { entity: res.did, authority: 'issue:Whatever' }, body: undefined });
    expect(badAuthority.body.authorized).toBe(false);
    await expect(authz.handler(ctx, { params: {}, query: {}, body: undefined })).rejects.toMatchObject({ status: 400 });

    const recog = await route(routes, 'GET', '/recognition').handler(ctx, { params: {}, query: {}, body: undefined });
    expect(recog.body.pods).toEqual([
      { slug: 'boulder', did: res.did, anchors: ['did:key:zAnchor'], acceptedIssuers: [res.did], manifestUrl: 'https://boulder.bioregionalpassport.org/.well-known/bioregion.json' },
    ]);
    const pods = await route(routes, 'GET', '/pods').handler(ctx, { params: {}, query: {}, body: undefined });
    expect(pods.body.pods[0]).not.toHaveProperty('anchors');
    const one = await route(routes, 'GET', '/pods/:slug').handler(ctx, { params: { slug: 'boulder' }, query: {}, body: undefined });
    expect(one.body.card.slug).toBe('boulder');
    expect(one.body.manifest.proof).toBeDefined();
    await expect(route(routes, 'GET', '/pods/:slug').handler(ctx, { params: { slug: 'nope' }, query: {}, body: undefined })).rejects.toMatchObject({ status: 404 });
  });
});

describe('control routes', () => {
  it('provisions, re-provisions, verifies and exports via operator routes', async () => {
    const ctx: PlatformContext = { db, platformDomain: DOMAIN, masterKey: MASTER };
    const routes = createControlRoutes();
    expect(routes.every((r) => r.auth === 'operator')).toBe(true);
    const created = await route(routes, 'POST', '/pods').handler(ctx, { params: {}, query: {}, body: tenantZeroManifest });
    expect(created.status).toBe(201);
    const put = route(routes, 'PUT', '/pods/:slug/manifest');
    const upd = await put.handler(ctx, {
      params: { slug: 'tenant-zero' },
      query: {},
      body: { ...tenantZeroManifest, copy: { en: { 'cta.findEvent': 'Come along' } } },
    });
    expect(upd.body.steps.find((s: any) => s.name === 'manifest').status).toBe('updated');
    await expect(put.handler(ctx, { params: { slug: 'tenant-zero' }, query: {}, body: boulderManifest })).rejects.toMatchObject({ code: 'SLUG_MISMATCH' });
    const verified = await route(routes, 'POST', '/pods/:slug/verify').handler(ctx, { params: { slug: 'tenant-zero' }, query: {}, body: undefined });
    expect(verified.body.ok).toBe(true);
    const exported = await route(routes, 'GET', '/pods/:slug/export').handler(ctx, { params: { slug: 'tenant-zero' }, query: {}, body: undefined });
    expect(exported.body.tables.policy_versions).toHaveLength(1);
  });
});

describe('exportPod', () => {
  it('includes the manifest, DID document, policy and every pod table', async () => {
    const res = await provision(tenantZeroManifest);
    const bundle = await exportPod(db, 'tenant-zero');
    expect(bundle.manifest.identity.did).toBe(res.did);
    expect(bundle.didDocument?.id).toBe(res.did);
    expect(bundle.policy?.version).toBe(1);
    expect(bundle.tables.policy_versions).toHaveLength(1);
    expect(Object.keys(bundle.tables)).toEqual(expect.arrayContaining(['members', 'records', 'ledger_entries', '_migrations']));
    expect(() => JSON.stringify(bundle)).not.toThrow();
  });
});

describe('verifyPod', () => {
  it('passes for tenant zero with optional deps skipped and records a tenant_zero_runs row', async () => {
    await provision(tenantZeroManifest);
    const report = await verifyPod({ db, slug: 'tenant-zero', platformDomain: DOMAIN, masterKey: MASTER });
    expect(report.ok).toBe(true);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    for (const name of ['did-document', 'manifest-signature', 'policy-signature', 'schema']) {
      expect(byName[name]).toMatchObject({ ok: true });
      expect(byName[name]?.skipped).toBeUndefined();
    }
    for (const name of ['vta-ceremony', 'ledger-transfer', 'appview-record']) expect(byName[name]).toMatchObject({ ok: true, skipped: true });
    const runs = await db.query('select ok, report from platform.tenant_zero_runs');
    expect(runs).toHaveLength(1);
    expect(runs[0].ok).toBe(true);
    expect(runs[0].report.checks).toHaveLength(report.checks.length);
  });

  it('runs duck-typed smoke hooks and fails when one throws', async () => {
    await provision(boulderManifest);
    const seen: string[] = [];
    const report = await verifyPod({
      db,
      slug: 'boulder',
      platformDomain: DOMAIN,
      masterKey: MASTER,
      deps: {
        vta: { ceremonyBackHalf: async (ctx: any, h: any) => { seen.push(ctx.podDid, h.signer.did); return { ok: true }; } },
        gateway: { smokeTransfer: async () => { throw new Error('ledger down'); } },
        appview: {},
      },
    });
    expect(seen).toHaveLength(2);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'ledger-transfer')).toMatchObject({ ok: false, detail: 'ledger down' });
    expect(report.checks.find((c) => c.name === 'appview-record')).toMatchObject({ skipped: true });
    expect(await db.query('select * from platform.tenant_zero_runs')).toHaveLength(0);
  });

  it('fails when the manifest is tampered with', async () => {
    await provision(boulderManifest);
    await db.query("update platform.pods set manifest = jsonb_set(manifest, '{identity,name}', '\"Evil\"') where slug = 'boulder'");
    const report = await verifyPod({ db, slug: 'boulder', platformDomain: DOMAIN, masterKey: MASTER });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'manifest-signature')?.ok).toBe(false);
  });
});

describe('tenantZeroJob', () => {
  it('provisions and verifies tenant zero', async () => {
    const report = await tenantZeroJob(db, DOMAIN, MASTER);
    expect(report.ok).toBe(true);
    expect(report.provision.slug).toBe('tenant-zero');
    const again = await tenantZeroJob(db, DOMAIN, MASTER);
    expect(again.provision.steps.every((s) => s.status === 'unchanged')).toBe(true);
    expect(await db.query('select * from platform.tenant_zero_runs')).toHaveLength(2);
  });

  it('with failOnSkipped, a missing smoke hook fails the run instead of passing as skipped', async () => {
    const hollow = await tenantZeroJob(db, DOMAIN, MASTER, undefined, { failOnSkipped: true });
    expect(hollow.ok).toBe(false);
    const skipped = hollow.verify.checks.filter((c) => c.skipped);
    expect(skipped.map((c) => c.name).sort()).toEqual(['appview-record', 'ledger-transfer', 'vta-ceremony']);
    expect(skipped.every((c) => !c.ok && /skips fail this run/.test(c.detail ?? ''))).toBe(true);

    const hooked = await tenantZeroJob(
      db,
      DOMAIN,
      MASTER,
      {
        vta: { ceremonyBackHalf: async () => ({ ok: true }) },
        gateway: { smokeTransfer: async () => ({ ok: true }) },
        appview: { smokeRecord: async () => ({ ok: true }) },
      },
      { failOnSkipped: true },
    );
    expect(hooked.ok).toBe(true);
    expect(hooked.verify.skipped).toBe(0);
  });
});

describe('fix round 1', () => {
  it('I1: a void seeder reports created, then unchanged on the re-run', async () => {
    const seedRecords = async (ctx: any) => {
      await ctx.db.query(
        "insert into records (uri, collection, bioregion, record) values ('at://tenant-zero/org.bioregion.event/1', 'event', $1, '{}') on conflict do nothing",
        [ctx.slug],
      );
    };
    const first = await provisionPod({ manifest: tenantZeroManifest, db, platformDomain: DOMAIN, masterKey: MASTER, deps: { seedRecords } });
    expect(first.steps.find((s) => s.name === 'seed-records')?.status).toBe('created');
    const second = await provisionPod({ manifest: tenantZeroManifest, db, platformDomain: DOMAIN, masterKey: MASTER, deps: { seedRecords } });
    expect(second.steps.every((s) => s.status === 'unchanged')).toBe(true);
  });

  const withAnchors = (anchors: string[]) => ({ ...boulderManifest, governance: { ...boulderManifest.governance, anchors } });

  it('I2: refuses anchor removal, allows it with allowDowngrade, and keeps every signed version', async () => {
    await provision(withAnchors(['did:key:zA', 'did:key:zB']));
    await expect(provision(withAnchors(['did:key:zA']))).rejects.toMatchObject({ status: 409, code: 'DOWNGRADE_REFUSED', message: expect.stringContaining('did:key:zB') });
    const allowed = await provisionPod({ manifest: withAnchors(['did:key:zA']), db, platformDomain: DOMAIN, masterKey: MASTER, allowDowngrade: true });
    expect(allowed.steps.find((s) => s.name === 'manifest')).toMatchObject({ status: 'updated', detail: expect.stringContaining('removed anchors: did:key:zB') });
    await provision(withAnchors(['did:key:zA', 'did:key:zC'])); // adding anchors is not a downgrade
    await provision(withAnchors(['did:key:zA', 'did:key:zC'])); // unchanged: no new version
    const versions = await db.query<{ version: number; manifest_hash: string; manifest: any }>(
      "select version, manifest_hash, manifest from platform.manifest_versions where slug = 'boulder' order by version",
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(versions[0]?.manifest.governance.anchors).toEqual(['did:key:zA', 'did:key:zB']);
    expect(versions.every((v) => v.manifest.proof)).toBe(true);
  });

  it('I2: refuses a lower $schema version', async () => {
    await provision({ ...boulderManifest, $schema: 'https://bioregion.org/schemas/manifest/v1.2' });
    await expect(provision({ ...boulderManifest, $schema: 'https://bioregion.org/schemas/manifest/v1.1' })).rejects.toMatchObject({ code: 'DOWNGRADE_REFUSED' });
  });

  it('I2: POST /pods refuses to overwrite an existing active pod with a different manifest', async () => {
    const ctx: PlatformContext = { db, platformDomain: DOMAIN, masterKey: MASTER };
    const post = route(createControlRoutes(), 'POST', '/pods');
    expect((await post.handler(ctx, { params: {}, query: {}, body: tenantZeroManifest })).status).toBe(201);
    expect((await post.handler(ctx, { params: {}, query: {}, body: tenantZeroManifest })).status).toBe(200);
    await expect(
      post.handler(ctx, { params: {}, query: {}, body: { ...tenantZeroManifest, copy: { en: { 'cta.findEvent': 'x' } } } }),
    ).rejects.toMatchObject({ status: 409, code: 'POD_EXISTS', message: 'This pod already exists; use PUT /pods/tenant-zero/manifest to update it.' });
    const put = route(createControlRoutes(), 'PUT', '/pods/:slug/manifest');
    await put.handler(ctx, { params: { slug: 'tenant-zero' }, query: {}, body: { ...tenantZeroManifest, governance: { ...tenantZeroManifest.governance, anchors: ['did:key:zA'] } } });
    await expect(put.handler(ctx, { params: { slug: 'tenant-zero' }, query: {}, body: tenantZeroManifest })).rejects.toMatchObject({ code: 'DOWNGRADE_REFUSED' });
    const ok = await put.handler(ctx, { params: { slug: 'tenant-zero' }, query: { allowDowngrade: 'true' }, body: tenantZeroManifest });
    expect(ok.body.steps.find((s: any) => s.name === 'manifest').status).toBe('updated');
  });

  it('M2: the pod signer does not expose the private key', async () => {
    await provision(tenantZeroManifest);
    const signer = await loadPodSigner(db, 'tenant-zero', MASTER);
    expect(Object.keys(signer).sort()).toEqual(['did', 'kid', 'publicKeyMultibase', 'sign']);
  });

  it('M3: verification never fetches over the network', async () => {
    await provision(boulderManifest);
    await db.query(
      "update platform.pods set manifest = jsonb_set(manifest, '{proof,verificationMethod}', '\"did:web:evil.example#key-1\"') where slug = 'boulder'",
    );
    const report = await verifyPod({ db, slug: 'boulder', platformDomain: DOMAIN, masterKey: MASTER });
    expect(report.checks.find((c) => c.name === 'manifest-signature')).toMatchObject({ ok: false, detail: expect.stringMatching(/no network in verify/) });
  });

  it('I4: the verify report counts skipped checks', async () => {
    await provision(tenantZeroManifest);
    const report = await verifyPod({ db, slug: 'tenant-zero', platformDomain: DOMAIN, masterKey: MASTER });
    expect(report.skipped).toBe(3);
  });

  it('M1: the key ciphertext is bound to slug|kid and the IV length is checked', async () => {
    await provision(tenantZeroManifest);
    await provision(boulderManifest);
    // Copy tenant-zero's ciphertext onto boulder: the AAD no longer matches.
    await db.query(
      "update platform.pod_keys set encrypted_private_key = (select encrypted_private_key from platform.pod_keys where slug = 'tenant-zero') where slug = 'boulder'",
    );
    await expect(loadPodSigner(db, 'boulder', MASTER)).rejects.toThrow(/does not match/);
    await db.query("update platform.pod_keys set encrypted_private_key = 'AAAA.' || split_part(encrypted_private_key, '.', 2) where slug = 'tenant-zero'");
    await expect(loadPodSigner(db, 'tenant-zero', MASTER)).rejects.toThrow(/3-byte IV; expected 12/);
  });
});

describe('fix round 2', () => {
  it('rolls back the manifest change when the version insert fails', async () => {
    const first = await provision(boulderManifest);
    const before = (await db.query("select manifest_hash, manifest from platform.pods where slug = 'boulder'"))[0];
    // Make the next version insert fail (version 2 would violate this constraint).
    await db.query('alter table platform.manifest_versions add constraint only_v1 check (version < 2)');
    const changed = { ...boulderManifest, governance: { ...boulderManifest.governance, anchors: ['did:key:zNew'] } };
    await expect(provision(changed)).rejects.toThrow();
    const after = (await db.query("select manifest_hash, manifest from platform.pods where slug = 'boulder'"))[0];
    expect(after.manifest_hash).toBe(before.manifest_hash);
    expect(after.manifest).toEqual(first.manifest);
    const reg = (await db.query("select anchors from platform.registry_entries where slug = 'boulder'"))[0];
    expect(reg.anchors).toEqual([]);
    // Once the failure is gone the change is applied and recorded, not skipped as "unchanged".
    await db.query('alter table platform.manifest_versions drop constraint only_v1');
    const retry = await provision(changed);
    expect(retry.steps.find((s) => s.name === 'manifest')?.status).toBe('updated');
    expect(retry.steps.find((s) => s.name === 'registry')?.status).toBe('updated');
    const versions = await db.query("select version from platform.manifest_versions where slug = 'boulder' order by version");
    expect(versions.map((v: any) => v.version)).toEqual([1, 2]);
  });
});
