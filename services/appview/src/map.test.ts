import { describe, expect, it } from 'vitest';
import { seedDemoRecords } from './seed.js';
import { createAppviewRoutes } from './routes.js';
import { setupTestDb, withTestPod, boulderManifest } from './testHelpers.js';

const routes = createAppviewRoutes();
function route(method: string, path: string) {
  const r = routes.find((r) => r.method === method && r.path === path);
  if (!r) throw new Error(`no route ${method} ${path}`);
  return r;
}

describe('GET /map', () => {
  it('returns only features inside the given bbox', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      await seedDemoRecords(ctx);

      const r = route('GET', '/map');

      // A tight bbox around downtown Boulder (Pearl St corridor) should hit
      // several seeded enterprises/events but not all of them.
      const tight = await r.handler(ctx, {
        params: {},
        query: { bbox: '-105.29,40.00,-105.26,40.03' },
        body: undefined,
      });
      expect(tight.body.type).toBe('FeatureCollection');
      expect(tight.body.features.length).toBeGreaterThan(0);
      for (const f of tight.body.features) {
        const [lon, lat] = f.geometry.coordinates;
        expect(lon).toBeGreaterThanOrEqual(-105.29);
        expect(lon).toBeLessThanOrEqual(-105.26);
        expect(lat).toBeGreaterThanOrEqual(40.0);
        expect(lat).toBeLessThanOrEqual(40.03);
      }

      // A bbox far outside Boulder's bounds should return nothing.
      const empty = await r.handler(ctx, {
        params: {},
        query: { bbox: '10,10,11,11' },
        body: undefined,
      });
      expect(empty.body.features).toEqual([]);
    });
    await db.close();
  });

  it('defaults to manifest.place.bounds when no bbox is given', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      await seedDemoRecords(ctx);
      const r = route('GET', '/map');
      const result = await r.handler(ctx, { params: {}, query: {}, body: undefined });
      expect(result.body.features.length).toBeGreaterThan(0);
      for (const f of result.body.features) {
        expect(f.properties.uri).toBeTruthy();
        expect(['enterprise', 'event', 'place']).toContain(f.properties.collection);
      }
    });
    await db.close();
  });

  it('rejects a malformed or inverted bbox with INVALID_BBOX instead of silently falling back', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      const r = route('GET', '/map');

      await expect(
        r.handler(ctx, { params: {}, query: { bbox: '1,2,3' }, body: undefined }),
      ).rejects.toMatchObject({ status: 400, code: 'INVALID_BBOX' });

      await expect(
        r.handler(ctx, { params: {}, query: { bbox: 'not,a,valid,bbox' }, body: undefined }),
      ).rejects.toMatchObject({ status: 400, code: 'INVALID_BBOX' });

      // Inverted: maxLon < minLon.
      await expect(
        r.handler(ctx, { params: {}, query: { bbox: '-105.1,40.2,-105.7,39.9' }, body: undefined }),
      ).rejects.toMatchObject({ status: 400, code: 'INVALID_BBOX' });
    });
    await db.close();
  });
});
