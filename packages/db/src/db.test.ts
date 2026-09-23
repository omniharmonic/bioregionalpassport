import { describe, expect, it } from 'vitest';
import { createTestDb, createTestPod } from './adapters/pglite.js';
import { migratePlatform, migratePod, pendingMigrations, sqlFiles } from './migrate.js';
import { podSchema } from './podSchema.js';
import { withPod, withPlatform } from './withPod.js';
import { listPods } from './listPods.js';

const POD_TABLES = [
  'members',
  'edge_commitments',
  'witness_refs',
  'events',
  'vac_issuance_log',
  'policy_versions',
  'groups',
  'rounds',
  'proposals',
  'ballots',
  'adjustments',
  'enterprises',
  'acceptance_rules',
  'accounts',
  'ledger_entries',
  'commitments',
  'pos_grants',
  'disputes',
  'records',
  'offers',
];

describe('podSchema', () => {
  it('maps a slug to its schema name', () => {
    expect(podSchema('boulder')).toBe('pod_boulder');
    expect(podSchema('tenant-zero')).toBe('pod_tenant_zero');
  });

  it('rejects an invalid slug', () => {
    expect(() => podSchema('Bad Slug')).toThrow('invalid pod slug');
  });
});

describe('sqlFiles', () => {
  it('lists the bundled migration files', async () => {
    const files = await sqlFiles();
    expect(files.platform).toEqual(['0001_init.sql']);
    expect(files.pod).toEqual(['0001_init.sql']);
  });
});

describe('migratePlatform', () => {
  it('is idempotent: a second run applies nothing', async () => {
    const db = await createTestDb(); // already migrates platform once
    const before = await db.query('select name from platform._migrations order by name');
    expect(before.length).toBeGreaterThan(0);

    await migratePlatform(db); // second run
    const after = await db.query('select name from platform._migrations order by name');
    expect(after).toEqual(before);

    await db.close();
  });

  it('creates the platform tables', async () => {
    const db = await createTestDb();
    const rows = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'platform' and table_name != '_migrations' order by table_name",
    );
    const names = rows.map((r) => r.table_name).sort();
    expect(names).toEqual(
      ['pod_keys', 'pods', 'registry_entries', 'relay_messages', 'tenant_zero_runs'].sort(),
    );
    await db.close();
  });
});

describe('migratePod', () => {
  it('creates isolated schemas with all pod tables for two slugs', async () => {
    const db = await createTestDb();
    await migratePod(db, 'boulder');
    await migratePod(db, 'tenant-zero');

    for (const [slug, schema] of [
      ['boulder', 'pod_boulder'],
      ['tenant-zero', 'pod_tenant_zero'],
    ] as const) {
      const rows = await db.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = $1 and table_name != '_migrations' order by table_name`,
        [schema],
      );
      const names = rows.map((r) => r.table_name).sort();
      expect(names, `tables for ${slug}`).toEqual([...POD_TABLES].sort());
    }

    await db.close();
  });

  it('is idempotent per schema', async () => {
    const db = await createTestDb();
    await migratePod(db, 'boulder');
    await migratePod(db, 'boulder'); // second run should apply nothing new
    const rows = await db.query('select name from pod_boulder._migrations');
    expect(rows.length).toBe(1);
    await db.close();
  });
});

describe('pendingMigrations', () => {
  it('returns [] after migrating', async () => {
    const db = await createTestDb();
    expect(await pendingMigrations(db, 'platform')).toEqual([]);

    await migratePod(db, 'boulder');
    expect(await pendingMigrations(db, 'pod_boulder')).toEqual([]);

    await db.close();
  });
});

describe('withPod tenancy isolation', () => {
  it('rows inserted in one pod are invisible from another pod', async () => {
    const db = await createTestDb();
    await createTestPod(db, 'boulder');
    await createTestPod(db, 'tenant-zero');

    await withPod(db, 'boulder', async (tx) => {
      await tx.query("insert into members (did, tier) values ('did:key:zBoulderMember', 'T1')");
    });

    const boulderMembers = await withPod(db, 'boulder', (tx) => tx.query('select did from members'));
    expect(boulderMembers).toHaveLength(1);

    const tenantZeroMembers = await withPod(db, 'tenant-zero', (tx) => tx.query('select did from members'));
    expect(tenantZeroMembers).toHaveLength(0);

    await db.close();
  });

  it('rolls back on a thrown error', async () => {
    const db = await createTestDb();
    await createTestPod(db, 'boulder');

    await expect(
      withPod(db, 'boulder', async (tx) => {
        await tx.query("insert into members (did, tier) values ('did:key:zRollback', 'T1')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const rows = await withPod(db, 'boulder', (tx) => tx.query('select did from members'));
    expect(rows).toHaveLength(0);

    await db.close();
  });

  it('rejects an invalid pod slug before opening a transaction', async () => {
    const db = await createTestDb();
    await expect(withPod(db, 'Bad Slug', async (tx) => tx.query('select 1'))).rejects.toThrow(
      'invalid pod slug',
    );
    await db.close();
  });
});

describe('withPlatform', () => {
  it('scopes search_path to platform', async () => {
    const db = await createTestDb();
    const rows = await withPlatform(db, (tx) => tx.query('select slug from pods'));
    expect(rows).toEqual([]);
    await db.close();
  });
});

describe('listPods', () => {
  it('lists pods from platform.pods ordered by slug', async () => {
    const db = await createTestDb();
    await db.query(
      "insert into platform.pods (slug, did, name, manifest, status) values ('tenant-zero', 'did:web:example.org:dids:tenant-zero', 'Tenant Zero', '{}'::jsonb, 'active')",
    );
    await db.query(
      "insert into platform.pods (slug, did, name, manifest, status) values ('boulder', 'did:web:example.org:dids:boulder', 'Boulder Commons', '{}'::jsonb, 'active')",
    );

    const pods = await listPods(db);
    expect(pods.map((p) => p.slug)).toEqual(['boulder', 'tenant-zero']);
    expect(pods[0]).toMatchObject({ slug: 'boulder', status: 'active' });

    await db.close();
  });
});
