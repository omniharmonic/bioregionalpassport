import { describe, expect, it } from 'vitest';
import { seedDemoRecords } from './seed.js';
import { schemaOrgGraph } from './schemaOrg.js';
import { ServiceError } from './kit.js';
import { setupTestDb, withTestPod, boulderManifest } from './testHelpers.js';

describe('schemaOrgGraph', () => {
  it('produces a LocalBusiness shape with @context and @type for enterprises', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      await seedDemoRecords(ctx);
      const graph = await schemaOrgGraph(ctx, 'enterprise');
      expect(graph['@context']).toBe('https://schema.org');
      expect(Array.isArray(graph['@graph'])).toBe(true);
      const businesses = graph['@graph'] as Record<string, unknown>[];
      expect(businesses.length).toBe(8);
      for (const b of businesses) {
        expect(b['@type']).toBe('LocalBusiness');
        expect(typeof b.name).toBe('string');
        expect(b.geo).toMatchObject({ '@type': 'GeoCoordinates' });
      }
      const withCredit = businesses.find((b) => (b as any).additionalProperty?.value === true);
      expect(withCredit).toBeTruthy();
    });
    await db.close();
  });

  it('produces an Event shape for events', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      await seedDemoRecords(ctx);
      const graph = await schemaOrgGraph(ctx, 'event');
      const events = graph['@graph'] as Record<string, unknown>[];
      expect(events.length).toBe(3);
      for (const e of events) {
        expect(e['@type']).toBe('Event');
        expect(typeof e.startDate).toBe('string');
      }
    });
    await db.close();
  });

  it('produces a Project shape with funder = pod name', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      const { putRecord } = await import('./records.js');
      const { makeSession } = await import('./testHelpers.js');
      await putRecord(
        ctx,
        'project',
        undefined,
        { title: 'Creek Restoration', summary: 'Restore the creek bank.', budget: 500 },
        makeSession('did:key:zSteward', 'T3', []),
      );
      const graph = await schemaOrgGraph(ctx, 'project');
      const projects = graph['@graph'] as Record<string, unknown>[];
      expect(projects).toHaveLength(1);
      expect(projects[0]?.['@type']).toBe('Project');
      expect((projects[0] as any).funder).toMatchObject({ name: boulderManifest.identity.name });
    });
    await db.close();
  });

  it('rejects an unknown schema.org type', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      await expect(schemaOrgGraph(ctx, 'bogus')).rejects.toBeInstanceOf(ServiceError);
    });
    await db.close();
  });
});
