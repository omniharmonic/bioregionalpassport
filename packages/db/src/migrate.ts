import { readdir, readFile } from 'node:fs/promises';
import type { Db } from './types.js';
import { podSchema } from './podSchema.js';
import { quoteIdent } from './withPod.js';
import { splitStatements } from './splitStatements.js';

const PLATFORM_DIR = new URL('../migrations/platform/', import.meta.url);
const POD_DIR = new URL('../migrations/pod/', import.meta.url);

async function listSqlFiles(dir: URL): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

async function readSql(dir: URL, name: string): Promise<string> {
  return readFile(new URL(name, dir), 'utf8');
}

/** Lists the migration file names bundled with this package, for CI diagnostics. */
export async function sqlFiles(): Promise<{ platform: string[]; pod: string[] }> {
  const [platform, pod] = await Promise.all([listSqlFiles(PLATFORM_DIR), listSqlFiles(POD_DIR)]);
  return { platform, pod };
}

async function ensureMigrationsTable(db: Db, schema: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    await tx.query(`SET LOCAL search_path TO ${quoteIdent(schema)}, public`);
    await tx.query(
      'CREATE TABLE IF NOT EXISTS _migrations (name text primary key, applied_at timestamptz not null default now())',
    );
  });
}

async function applyMigrations(db: Db, schema: string, dir: URL): Promise<void> {
  await ensureMigrationsTable(db, schema);
  const files = await listSqlFiles(dir);
  for (const file of files) {
    await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL search_path TO ${quoteIdent(schema)}, public`);
      const applied = await tx.query<{ name: string }>('SELECT name FROM _migrations WHERE name = $1', [file]);
      if (applied.length > 0) return;
      const sql = await readSql(dir, file);
      for (const statement of splitStatements(sql)) {
        await tx.query(statement);
      }
      await tx.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
    });
  }
}

/** Applies all pending `migrations/platform/*.sql` files, tracked in `platform._migrations`. Idempotent. */
export async function migratePlatform(db: Db): Promise<void> {
  await applyMigrations(db, 'platform', PLATFORM_DIR);
}

/**
 * Creates `pod_<slug>` if missing and applies all pending `migrations/pod/*.sql`
 * files, tracked in `<schema>._migrations`. Idempotent.
 */
export async function migratePod(db: Db, slug: string): Promise<void> {
  const schema = podSchema(slug);
  await applyMigrations(db, schema, POD_DIR);
}

/** Returns the migration file names not yet applied to `schema` (`'platform'` or a `pod_<slug>` schema). */
export async function pendingMigrations(db: Db, schema: string): Promise<string[]> {
  const dir = schema === 'platform' ? PLATFORM_DIR : POD_DIR;
  const files = await listSqlFiles(dir);
  const rows = await db.transaction(async (tx) => {
    await tx.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    await tx.query(`SET LOCAL search_path TO ${quoteIdent(schema)}, public`);
    await tx.query(
      'CREATE TABLE IF NOT EXISTS _migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    return tx.query<{ name: string }>('SELECT name FROM _migrations');
  });
  const applied = new Set(rows.map((r) => r.name));
  return files.filter((f) => !applied.has(f));
}
