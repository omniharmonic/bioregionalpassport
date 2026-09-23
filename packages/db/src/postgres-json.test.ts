import { describe, expect, it } from 'vitest';
import { createDb } from './adapters/postgres.js';

// PGlite does not go through postgres.js' wire protocol or its default
// json/jsonb type handlers, so it cannot reproduce the double-encoding bug
// this fix addresses (see adapters/postgres.ts). This test only runs
// against a real Postgres instance, opted into via TEST_DATABASE_URL (e.g.
// the Neon URL in the repo's own DATABASE_URL) — it is skipped otherwise
// so the default `pnpm --filter @passport/db test` run stays hermetic.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('createDb jsonb round-trip (real Postgres only)', () => {
  it('stores a plain object as real jsonb and reads it back as an object, not a double-encoded string', async () => {
    const db = createDb(url!);
    const table = `_passport_db_jsonb_roundtrip_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    try {
      await db.query(`CREATE TABLE public."${table}" (id int primary key, doc jsonb)`);

      // Convention 1: caller passes a raw object/array.
      const original = { signed: true, nested: { a: 1, b: ['x', 'y'] } };
      await db.query(`INSERT INTO public."${table}" (id, doc) VALUES ($1, $2)`, [1, original]);
      const rows1 = await db.query<{ doc: unknown }>(`SELECT doc FROM public."${table}" WHERE id = $1`, [1]);
      expect(rows1).toHaveLength(1);
      expect(typeof rows1[0]!.doc).toBe('object');
      expect(rows1[0]!.doc).toEqual(original);

      // Convention 2: caller pre-stringifies with JSON.stringify (some
      // service call sites in this codebase do this). Must not be
      // double-encoded into a jsonb string.
      const preStringified = JSON.stringify({ already: 'stringified', n: 2, arr: [true, false] });
      await db.query(`INSERT INTO public."${table}" (id, doc) VALUES ($1, $2)`, [2, preStringified]);
      const rows2 = await db.query<{ doc: unknown }>(`SELECT doc FROM public."${table}" WHERE id = $1`, [2]);
      expect(typeof rows2[0]!.doc).toBe('object');
      expect(rows2[0]!.doc).toEqual({ already: 'stringified', n: 2, arr: [true, false] });

      // A jsonb array round-trips as an array, not a string.
      await db.query(`INSERT INTO public."${table}" (id, doc) VALUES ($1, $2)`, [3, [1, 2, 3]]);
      const rows3 = await db.query<{ doc: unknown }>(`SELECT doc FROM public."${table}" WHERE id = $1`, [3]);
      expect(Array.isArray(rows3[0]!.doc)).toBe(true);
      expect(rows3[0]!.doc).toEqual([1, 2, 3]);
    } finally {
      await db.query(`DROP TABLE IF EXISTS public."${table}"`);
      await db.close();
    }
  });
});
