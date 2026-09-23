import { describe, expect, it } from 'vitest';
import { seedDemoRecords } from './seed.js';
import { listDirectory } from './directory.js';
import { setupTestDb, withTestPod, boulderManifest } from './testHelpers.js';

describe('listDirectory', () => {
  it('filters by category and acceptsLocalCredit', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      await seedDemoRecords(ctx);

      const all = await listDirectory(ctx);
      expect(all.length).toBe(8);

      const bakeries = await listDirectory(ctx, { category: 'bakery' });
      expect(bakeries).toHaveLength(1);
      expect(bakeries[0]?.record.name).toBe('Sourdough & Rye Bakery');

      const acceptsCredit = await listDirectory(ctx, { acceptsLocalCredit: true });
      expect(acceptsCredit).toHaveLength(6);
      expect(acceptsCredit.every((e) => e.record.acceptsLocalCredit === true)).toBe(true);

      const doesNotAccept = await listDirectory(ctx, { acceptsLocalCredit: false });
      expect(doesNotAccept).toHaveLength(2);

      // The bakery has a seeded offer.
      const bakery = bakeries[0]!;
      expect(bakery.offerCount).toBeGreaterThanOrEqual(1);
    });
    await db.close();
  });

  it('filters by a free-text query across name/description', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      await seedDemoRecords(ctx);
      const found = await listDirectory(ctx, { q: 'tool' });
      expect(found.some((e) => e.record.name === 'Chautauqua Tool Library')).toBe(true);
    });
    await db.close();
  });
});
