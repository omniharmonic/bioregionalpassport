import { PGlite } from '@electric-sql/pglite';
import type { Db } from '../types.js';
import { migratePlatform, migratePod } from '../migrate.js';

interface PGliteLike {
  query<T = any>(text: string, params?: any[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: PGliteLike) => Promise<T>): Promise<T>;
  close?: () => Promise<void>;
}

function wrap(pg: PGliteLike, inTransaction: boolean): Db {
  return {
    async query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
      const result = params.length > 0 ? await pg.query<T>(text, params as any[]) : await pg.query<T>(text);
      return result.rows;
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // Nested transactions reuse the current tx rather than opening a
      // savepoint, per the pod-service contract.
      if (inTransaction) {
        return fn(wrap(pg, true));
      }
      return pg.transaction(async (tx) => fn(wrap(tx as unknown as PGliteLike, true)));
    },
    async close(): Promise<void> {
      await pg.close?.();
    },
  };
}

/**
 * Creates an in-memory PGlite-backed `Db` with the platform schema already
 * migrated. Hermetic — never touches a real Postgres instance.
 */
export async function createTestDb(): Promise<Db> {
  const pg = new PGlite();
  const db = wrap(pg as unknown as PGliteLike, false);
  await migratePlatform(db);
  return db;
}

/** Migrates `pod_<slug>` on an existing test `Db`, for tests that need a pod schema. */
export async function createTestPod(db: Db, slug: string): Promise<void> {
  await migratePod(db, slug);
}
