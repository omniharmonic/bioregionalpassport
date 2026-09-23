import postgres from 'postgres';
import type { Db } from '../types.js';

// postgres.js' `Sql`/`TransactionSql` generics don't unify cleanly across
// `sql.begin`'s callback signature, so the underlying connection/tx handle
// is treated as `any` internally; the public surface stays fully typed via
// `Db`.
function wrap(sql: any, inTransaction: boolean): Db {
  return {
    async query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
      const rows = params.length > 0 ? await sql.unsafe(text, params) : await sql.unsafe(text);
      return rows as T[];
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // Nested transactions reuse the current tx rather than opening a
      // savepoint, per the pod-service contract.
      if (inTransaction) {
        return fn(wrap(sql, true));
      }
      return sql.begin(async (tx: any) => fn(wrap(tx, true)));
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}

/** Creates a `Db` backed by postgres.js against a live Postgres/Neon instance. */
export function createDb(url: string): Db {
  const sql = postgres(url);
  return wrap(sql as any, false);
}
