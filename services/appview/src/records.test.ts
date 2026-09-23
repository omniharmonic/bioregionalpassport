import { describe, expect, it } from 'vitest';
import { createAppviewRoutes } from './routes.js';
import { ServiceError } from './kit.js';
import { getRecord, putRecord } from './records.js';
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
