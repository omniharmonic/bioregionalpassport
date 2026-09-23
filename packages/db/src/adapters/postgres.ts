import postgres from 'postgres';
import type { Db } from '../types.js';

/**
 * jsonb/json serialize: pass an already-serialized JSON string straight
 * through; otherwise `JSON.stringify` a plain object/array.
 *
 * Root cause this works around: postgres.js' *default* `json`/`jsonb`
 * serializer is unconditionally `JSON.stringify`. Extended-protocol
 * queries (which `sql.unsafe(text, params)` always uses once parameters
 * are supplied) get the target column's real OID back from the server via
 * `ParameterDescription` before `Bind`, so a `jsonb` column is correctly
 * identified even for `.unsafe()` calls — but if the caller already
 * passed a pre-serialized JSON string (some call sites in this codebase
 * do `db.query(sql, [JSON.stringify(doc), ...])`), the default serializer
 * calls `JSON.stringify` on that string *again*, producing a JSON string
 * literal whose content is itself JSON text. Postgres stores that as a
 * jsonb *string* value, not the intended object/array. Readers who expect
 * an object (e.g. `presentation.proof`) instead get a string, which
 * surfaced in production against Neon as "Document is not signed" /
 * 500s on pod pages. PGlite does not go through postgres.js' wire
 * protocol or its default `json`/`jsonb` type handlers at all, so this
 * was invisible under the PGlite-only test suite. Making serialize
 * idempotent (skip re-stringifying a value that is already a string)
 * fixes both calling conventions without requiring every call site to
 * agree on one. See the Task 4 "Fix round" report for the trace that led
 * here and `apps/web/lib/db.ts`, which carried this same workaround at
 * the app layer until this fix landed in the adapter itself.
 */
const serializeJson = (x: unknown): string => (typeof x === 'string' ? x : JSON.stringify(x));

/**
 * jsonb/json parse: the normal case is a single `JSON.parse`. Rows
 * written by the pre-fix code (or by any other client that double-
 * encoded) hold a jsonb *string* whose content is itself JSON text for an
 * object/array; if the first parse yields such a string, parse it once
 * more and return that. A plain string value that does not itself parse
 * as an object/array is returned as a string unchanged — every jsonb
 * column in this schema (manifests, credentials, records, grants, ...) is
 * always a structured document, never a bare JSON-string scalar, so this
 * heuristic never mis-fires on correctly-written data; it only recovers
 * legacy double-encoded rows. New writes never produce a double-encoded
 * value in the first place once `serializeJson` above is idempotent, so
 * this is a read-side safety net, not a replacement for re-provisioning
 * pods that already hold corrupted rows (recommended where practical).
 */
const parseJson = (raw: string): unknown => {
  const value: unknown = JSON.parse(raw);
  if (typeof value === 'string') {
    try {
      const inner: unknown = JSON.parse(value);
      if (inner !== null && typeof inner === 'object') return inner;
    } catch {
      // Not double-encoded JSON text — leave the plain string as-is.
    }
  }
  return value;
};

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
  const sql = postgres(url, {
    onnotice: () => {},
    types: {
      json: { to: 114, from: [114], serialize: serializeJson, parse: parseJson },
      jsonb: { to: 3802, from: [3802], serialize: serializeJson, parse: parseJson },
    },
  });
  return wrap(sql as any, false);
}
