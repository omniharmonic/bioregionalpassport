import type { Db } from './types.js';
import { podSchema } from './podSchema.js';

/** Double-quotes a Postgres identifier, escaping embedded quotes. */
export function quoteIdent(ident: string): string {
  return '"' + ident.replaceAll('"', '""') + '"';
}

/**
 * Runs `fn` inside a transaction with `search_path` scoped to the pod's schema.
 * Uses `SET LOCAL` so the setting is confined to the transaction and never
 * leaks onto the underlying connection once it commits or rolls back
 * (verified against both postgres.js and PGlite).
 */
export async function withPod<T>(db: Db, slug: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  const schema = podSchema(slug);
  return db.transaction(async (tx) => {
    await tx.query(`SET LOCAL search_path TO ${quoteIdent(schema)}, public`);
    return fn(tx);
  });
}

/** Same as `withPod` but scoped to the `platform` schema. */
export async function withPlatform<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query('SET LOCAL search_path TO platform, public');
    return fn(tx);
  });
}
