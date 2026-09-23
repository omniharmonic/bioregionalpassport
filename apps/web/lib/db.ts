import 'server-only';
import postgres from 'postgres';
import type { Db } from '@passport/db';
import { env } from './env';

/**
 * postgres.js `Db` for the web app.
 *
 * Same contract as `@passport/db`'s `createDb`, with one difference: values
 * bound to `json`/`jsonb` parameters that are already strings are sent as-is.
 * Services write `JSON.stringify(x)` into jsonb columns (which PGlite accepts
 * verbatim); stock postgres.js would JSON-encode that string a second time and
 * store a jsonb *string*. See the Task 11 report.
 */
const jsonSafe = (x: unknown): string => (typeof x === 'string' ? x : JSON.stringify(x));

function wrap(sql: any, inTransaction: boolean): Db {
  return {
    async query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
      const rows = params.length > 0 ? await sql.unsafe(text, params) : await sql.unsafe(text);
      return rows as T[];
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if (inTransaction) return fn(wrap(sql, true));
      return sql.begin(async (tx: any) => fn(wrap(tx, true)));
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}

export function createWebDb(url: string): Db {
  const sql = postgres(url, {
    types: {
      json: { to: 114, from: [114], serialize: jsonSafe, parse: (x: string) => JSON.parse(x) },
      jsonb: { to: 3802, from: [3802], serialize: jsonSafe, parse: (x: string) => JSON.parse(x) },
    },
    // Postgres NOTICEs (e.g. "schema already exists, skipping") are not errors.
    onnotice: () => {},
    // Serverless: keep the pool small and let idle connections go.
    max: 5,
    idle_timeout: 20,
  });
  return wrap(sql, false);
}

const globalForDb = globalThis as unknown as { __passportDb?: Db };

/** One postgres.js pool per server instance, reused across dev HMR reloads. */
export function db(): Db {
  globalForDb.__passportDb ??= createWebDb(env().DATABASE_URL);
  return globalForDb.__passportDb;
}

/** Parses a jsonb value that an older write stored double-encoded (a JSON string of JSON). */
export function jsonValue<T>(v: unknown): T {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return v as T;
    }
  }
  return v as T;
}
