import { describe, expect, it } from 'vitest';
import { createAppviewRoutes } from './routes.js';
import { ServiceError } from './kit.js';
import { getRecord, listRecords, putRecord } from './records.js';
import { seedDemoRecords } from './seed.js';
import { setupTestDb, withTestPod, boulderManifest, makeSession } from './testHelpers.js';

const routes = createAppviewRoutes();
function route(method: string, path: string) {
  const r = routes.find((r) => r.method === method && r.path === path);
  if (!r) throw new Error(`no route ${method} ${path}`);
  return r;
}

describe('records CRUD', () => {
  it('creates via POST, reads via GET, updates via PUT, deletes via DELETE', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      const session = makeSession('did:key:zAuthor', 'T1', ['event:attend']);
      const created = await putRecord(
        ctx,
        'group',
        undefined,
        { name: 'Test Group', description: 'x', did: 'did:web:example:group', contact: 'a@b.c' },
        session,
      );
      expect(created.authorDid).toBe('did:key:zAuthor');
      expect(created.record.name).toBe('Test Group');

      const read = await getRecord(ctx, 'group', created.rkey);
      expect(read?.uri).toBe(created.uri);

      const updated = await putRecord(
        ctx,
        'group',
        created.rkey,
        { name: 'Renamed Group', did: 'did:web:example:group', contact: 'a@b.c' },
        session,
      );
      expect(updated.record.name).toBe('Renamed Group');

      const other = makeSession('did:key:zOther', 'T1', []);
      await expect(
        putRecord(ctx, 'group', created.rkey, { name: 'Hijack', did: 'x', contact: 'y' }, other),
      ).rejects.toMatchObject({ code: 'NOT_AUTHOR', status: 403 });
    });
    await db.close();
  });

  it('refuses a body naming a different bioregion with POD_MISMATCH', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      const session = makeSession('did:key:zAuthor', 'T1', []);
      await expect(
        putRecord(
          ctx,
          'group',
          undefined,
          { bioregion: 'somewhere-else', name: 'X', did: 'did:web:x', contact: 'c' },
          session,
        ),
      ).rejects.toMatchObject({ code: 'POD_MISMATCH', status: 400 });
    });
    await db.close();
  });

  it('forces bioregion = ctx.slug even when omitted', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      const session = makeSession('did:key:zAuthor', 'T1', []);
      const row = await putRecord(
        ctx,
        'group',
        undefined,
        { name: 'X', did: 'did:web:x', contact: 'c' },
        session,
      );
      expect(row.record.bioregion).toBe('boulder');
      expect(row.bioregion).toBe('boulder');
    });
    await db.close();
  });

  it('requires at least T1 to create an enterprise', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      const t0 = makeSession('did:key:zVisitor', 'T0', []);
      await expect(
        putRecord(
          ctx,
          'enterprise',
          undefined,
          {
            name: 'Visitor Shop',
            categories: ['retail'],
            acceptsLocalCredit: false,
            acceptanceShare: 0,
            stewardDids: [],
          },
          t0,
        ),
      ).rejects.toMatchObject({ code: 'TIER_TOO_LOW', status: 403 });

      const t1 = makeSession('did:key:zMember', 'T1', []);
      const row = await putRecord(
        ctx,
        'enterprise',
        undefined,
        {
          name: 'Member Shop',
          categories: ['retail'],
          acceptsLocalCredit: false,
          acceptanceShare: 0,
          stewardDids: [],
        },
        t1,
      );
      expect(row.record.name).toBe('Member Shop');
    });
    await db.close();
  });

  it('routes offer/need collections through the offers table but exposes the same API', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      const session = makeSession('did:key:zAuthor', 'T1', []);
      const created = await putRecord(
        ctx,
        'offer',
        undefined,
        {
          resourceSpec: 'Eggs',
          quantity: { unit: 'dozen', value: 4 },
          enterprise: 'at://boulder/org.bioregion.enterprise/farm',
        },
        session,
      );
      expect(created.record.resourceSpec).toBe('Eggs');
      const [row] = await ctx.db.query<{ kind: string }>('SELECT kind FROM offers WHERE id = $1', [
        created.rkey,
      ]);
      expect(row?.kind).toBe('offer');

      const fetched = await getRecord(ctx, 'offer', created.rkey);
      expect(fetched?.record.resourceSpec).toBe('Eggs');
    });
    await db.close();
  });
});

describe('POST /records/:collection route', () => {
  it('returns 401 without a session', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      const r = route('POST', '/records/:collection');
      await expect(
        r.handler(ctx, {
          params: { collection: 'group' },
          query: {},
          body: { name: 'X', did: 'did:web:x', contact: 'c' },
        }),
      ).rejects.toBeInstanceOf(ServiceError);
      await expect(
        r.handler(ctx, {
          params: { collection: 'group' },
          query: {},
          body: { name: 'X', did: 'did:web:x', contact: 'c' },
        }),
      ).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    });
    await db.close();
  });

  it('creates a record with 201 when a session is present', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      const r = route('POST', '/records/:collection');
      const result = await r.handler(ctx, {
        params: { collection: 'group' },
        query: {},
        body: { name: 'X', did: 'did:web:x', contact: 'c' },
        session: makeSession('did:key:zAuthor', 'T1', []),
      });
      expect(result.status).toBe(201);
      expect(result.body.record.name).toBe('X');
    });
    await db.close();
  });
});

describe('keyset pagination', () => {
  it('advances nextCursor across pages and never repeats a row (records table)', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      await seedDemoRecords(ctx); // 8 enterprises

      const seen = new Set<string>();
      let cursor: string | undefined;
      let pageCount = 0;
      for (;;) {
        const page = await listRecords(ctx, 'enterprise', { limit: 3, cursor });
        expect(page.rows.length).toBeGreaterThan(0);
        for (const row of page.rows) {
          expect(seen.has(row.uri)).toBe(false);
          seen.add(row.uri);
        }
        pageCount++;
        expect(pageCount).toBeLessThan(10); // guards against an infinite loop if the cursor never advances
        if (!page.nextCursor) break;
        expect(page.nextCursor).not.toBe(cursor); // the cursor must actually move
        cursor = page.nextCursor;
      }
      expect(seen.size).toBe(8);
      expect(pageCount).toBe(3); // 3 + 3 + 2
    });
    await db.close();
  });

  it('advances nextCursor across pages for the offers table too, using its uri form', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      await seedDemoRecords(ctx); // 3 offers

      const page1 = await listRecords(ctx, 'offer', { limit: 2 });
      expect(page1.rows).toHaveLength(2);
      expect(page1.nextCursor).toBeTruthy();
      expect(page1.nextCursor).toMatch(/^at:\/\/boulder\/org\.bioregion\.offer\//);

      const page2 = await listRecords(ctx, 'offer', { limit: 2, cursor: page1.nextCursor! });
      expect(page2.rows).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();

      const page1Uris = new Set(page1.rows.map((r) => r.uri));
      for (const row of page2.rows) {
        expect(page1Uris.has(row.uri)).toBe(false);
      }
    });
    await db.close();
  });

  it('exposes nextCursor from the GET /records/:collection route', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      await seedDemoRecords(ctx);
      const r = route('GET', '/records/:collection');
      const first = await r.handler(ctx, { params: { collection: 'enterprise' }, query: { limit: '3' }, body: undefined });
      expect(first.body.records).toHaveLength(3);
      expect(first.body.nextCursor).toBeTruthy();

      const second = await r.handler(ctx, {
        params: { collection: 'enterprise' },
        query: { limit: '3', cursor: first.body.nextCursor },
        body: undefined,
      });
      expect(second.body.records).toHaveLength(3);
      const firstUris = new Set(first.body.records.map((row: { uri: string }) => row.uri));
      for (const row of second.body.records) {
        expect(firstUris.has(row.uri)).toBe(false);
      }
    });
    await db.close();
  });
});

describe('ILIKE escaping', () => {
  it('treats a literal % in q as a literal character, not a wildcard', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      const session = makeSession('did:key:zAuthor', 'T1', []);
      await putRecord(ctx, 'group', undefined, { name: '50% off Fest', did: 'did:web:a', contact: 'a@b.c' }, session);
      await putRecord(ctx, 'group', undefined, { name: 'Regular Meetup', did: 'did:web:b', contact: 'b@b.c' }, session);

      // Unescaped, a bare '%' ILIKE pattern ('%%%') would match every row.
      const { rows: matches } = await listRecords(ctx, 'group', { q: '%' });
      expect(matches).toHaveLength(1);
      expect(matches[0]?.record.name).toBe('50% off Fest');
    });
    await db.close();
  });

  it('treats a literal _ in q as a literal character, not a single-char wildcard', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      const session = makeSession('did:key:zAuthor', 'T1', []);
      await putRecord(ctx, 'group', undefined, { name: 'Neighbors United', did: 'did:web:a', contact: 'a@b.c' }, session);
      await putRecord(ctx, 'group', undefined, { name: 'Repair_Cafe', did: 'did:web:b', contact: 'b@b.c' }, session);

      // Unescaped, '_' matches any single character, so it would match both rows.
      const { rows: matches } = await listRecords(ctx, 'group', { q: '_' });
      expect(matches).toHaveLength(1);
      expect(matches[0]?.record.name).toBe('Repair_Cafe');
    });
    await db.close();
  });
});
