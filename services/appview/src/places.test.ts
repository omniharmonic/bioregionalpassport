import { describe, expect, it } from 'vitest';
import { resolvePlace } from './places.js';
import { ServiceError } from './kit.js';
import { setupTestDb, withTestPod, boulderManifest, tenantZeroManifest } from './testHelpers.js';

describe('resolvePlace', () => {
  it('resolves statically inside bounds using the manifest HUC', async () => {
    const db = await setupTestDb('tenant-zero');
    await withTestPod(db, 'tenant-zero', tenantZeroManifest, async (ctx) => {
      const result = await resolvePlace(ctx, 40.2, -105.1);
      expect(result).toEqual({
        placeId: 'huc12:101900050301',
        name: 'Tenant Zero watershed',
        source: 'static',
      });
    });
    await db.close();
  });

  it('refuses a point outside the bounds with OUT_OF_BOUNDS', async () => {
    const db = await setupTestDb('tenant-zero');
    await withTestPod(db, 'tenant-zero', tenantZeroManifest, async (ctx) => {
      await expect(resolvePlace(ctx, 0, 0)).rejects.toMatchObject({
        code: 'OUT_OF_BOUNDS',
        status: 404,
      });
      await expect(resolvePlace(ctx, 0, 0)).rejects.toBeInstanceOf(ServiceError);
    });
    await db.close();
  });

  it('calls the injected twinResolve for a twin-backed pod and falls back to static on failure', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      expect(ctx.manifest.place.watershedSource.type).toBe('twin');

      const twinResult = await resolvePlace(ctx, 40.015, -105.27, {
        twinResolve: async (lat, lon) => ({
          placeId: `huc12:twin-${lat}-${lon}`,
          name: 'Twin-resolved place',
          source: 'twin',
        }),
      });
      expect(twinResult.source).toBe('twin');
      expect(twinResult.name).toBe('Twin-resolved place');

      const fallback = await resolvePlace(ctx, 40.015, -105.27, {
        twinResolve: async () => {
          throw new Error('twin unreachable');
        },
      });
      expect(fallback.source).toBe('static');

      const noTwinDeps = await resolvePlace(ctx, 40.015, -105.27);
      expect(noTwinDeps.source).toBe('static');
    });
    await db.close();
  });
});
