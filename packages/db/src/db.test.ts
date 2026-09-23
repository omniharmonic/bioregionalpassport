import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createTestDb, createTestPod } from './adapters/pglite.js';
import { migratePlatform, migratePod, pendingMigrations, sqlFiles } from './migrate.js';
import { podSchema } from './podSchema.js';
import { withPod, withPlatform } from './withPod.js';
import { listPods } from './listPods.js';

async function sqlFilesOnDisk(dir: URL): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

// The core pod tables required by the MVP plan §4.3. Other services may add
// further tables in later-numbered migrations (e.g. trust-index side
// tables), so this is asserted as a minimum subset, not an exact table
// list — see CORE_PLATFORM_TABLES below for the same reasoning on the
// platform schema.
const CORE_POD_TABLES = [
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

const CORE_PLATFORM_TABLES = ['pod_keys', 'pods', 'registry_entries', 'relay_messages', 'tenant_zero_runs'];

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
  it('lists exactly the migration files present on disk', async () => {
    const [platformDisk, podDisk] = await Promise.all([
      sqlFilesOnDisk(new URL('../migrations/platform/', import.meta.url)),
      sqlFilesOnDisk(new URL('../migrations/pod/', import.meta.url)),
    ]);
    const files = await sqlFiles();
    expect(files.platform).toEqual(platformDisk);
    expect(files.pod).toEqual(podDisk);
    // this task's own migration must always be present, whatever else has
    // been added since
    expect(files.platform).toContain('0001_init.sql');
    expect(files.pod).toContain('0001_init.sql');
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

  it('creates at least the core platform tables', async () => {
    const db = await createTestDb();
    const rows = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'platform' and table_name != '_migrations' order by table_name",
    );
    const names = rows.map((r) => r.table_name);
    for (const table of CORE_PLATFORM_TABLES) {
      expect(names, `expected platform table '${table}'`).toContain(table);
    }
    await db.close();
  });

  it('records every migration file on disk as applied', async () => {
    const db = await createTestDb();
    const diskFiles = await sqlFilesOnDisk(new URL('../migrations/platform/', import.meta.url));
    const applied = await db.query<{ name: string }>('select name from platform._migrations');
    const appliedNames = applied.map((r) => r.name);
    for (const file of diskFiles) {
      expect(appliedNames, `expected '${file}' to be recorded as applied`).toContain(file);
    }
    await db.close();
  });
});

describe('migratePod', () => {
  it('creates isolated schemas with at least the core pod tables for two slugs', async () => {
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
      const names = rows.map((r) => r.table_name);
      for (const table of CORE_POD_TABLES) {
        expect(names, `expected pod table '${table}' for ${slug}`).toContain(table);
      }
    }

    await db.close();
  });

  it('records every migration file on disk as applied, for a fresh pod', async () => {
    const db = await createTestDb();
    await migratePod(db, 'boulder');
    const diskFiles = await sqlFilesOnDisk(new URL('../migrations/pod/', import.meta.url));
    const applied = await db.query<{ name: string }>('select name from pod_boulder._migrations');
    const appliedNames = applied.map((r) => r.name);
    for (const file of diskFiles) {
      expect(appliedNames, `expected '${file}' to be recorded as applied`).toContain(file);
    }
    await db.close();
  });

  it('is idempotent per schema: a second run leaves the applied-migrations row count unchanged', async () => {
    const db = await createTestDb();
    await migratePod(db, 'boulder');
    const before = await db.query('select name from pod_boulder._migrations order by name');

    await migratePod(db, 'boulder'); // second run should apply nothing new
    const after = await db.query('select name from pod_boulder._migrations order by name');

    expect(after).toEqual(before);
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
