import { describe, expect, it } from 'vitest';
import { seedDemoRecords } from './seed.js';
import { listRecords } from './records.js';
import { withPod } from '@passport/db';
import { setupTestDb, withTestPod, buildCtx, boulderManifest, tenantZeroManifest } from './testHelpers.js';

describe('seedDemoRecords', () => {
  it('seeds Boulder with 8 enterprises, 3 events, 2 groups, 3 offers and 2 needs, all authored by the pod', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      await seedDemoRecords(ctx);

      const { rows: enterprises } = await listRecords(ctx, 'enterprise', { limit: 100 });
      expect(enterprises).toHaveLength(8);
      expect(enterprises.every((e) => e.authorDid === ctx.podDid)).toBe(true);

      const { rows: events } = await listRecords(ctx, 'event', { limit: 100 });
      expect(events).toHaveLength(3);
      expect(events.filter((e) => e.record.attestation === true)).toHaveLength(1);

      const { rows: groups } = await listRecords(ctx, 'group', { limit: 100 });
      expect(groups).toHaveLength(2);

      const { rows: offers } = await listRecords(ctx, 'offer', { limit: 100 });
      expect(offers).toHaveLength(3);
      expect(offers.every((o) => o.authorDid === ctx.podDid)).toBe(true);

      const { rows: needs } = await listRecords(ctx, 'need', { limit: 100 });
      expect(needs).toHaveLength(2);
    });
    await db.close();
  });

  it('is idempotent: a second call adds nothing once any record exists', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      await seedDemoRecords(ctx);
      const before = await listRecords(ctx, 'enterprise', { limit: 100 });
      await seedDemoRecords(ctx);
      const after = await listRecords(ctx, 'enterprise', { limit: 100 });
      expect(after.rows).toHaveLength(before.rows.length);
    });
    await db.close();
  });

  it('seeds tenant-zero with 2 enterprises, 1 attestation event, 1 group, isolated from boulder', async () => {
    const db = await setupTestDb('boulder', 'tenant-zero');

    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      await seedDemoRecords(ctx);
    });
    await withTestPod(db, 'tenant-zero', tenantZeroManifest, async (ctx) => {
      await seedDemoRecords(ctx);
    });

    await withPod(db, 'tenant-zero', async (tx) => {
      const ctx = buildCtx(tx, 'tenant-zero', tenantZeroManifest);
      const { rows: enterprises } = await listRecords(ctx, 'enterprise', { limit: 100 });
      expect(enterprises).toHaveLength(2);
      const { rows: events } = await listRecords(ctx, 'event', { limit: 100 });
      expect(events).toHaveLength(1);
      expect(events[0]?.record.attestation).toBe(true);
      const { rows: groups } = await listRecords(ctx, 'group', { limit: 100 });
      expect(groups).toHaveLength(1);

      // None of tenant-zero's enterprises are the Boulder seed names.
      const names = enterprises.map((e) => e.record.name);
      expect(names).not.toContain('Kinnikinnick Farm Stand');
    });

    await withPod(db, 'boulder', async (tx) => {
      const ctx = buildCtx(tx, 'boulder', boulderManifest);
      const { rows: enterprises } = await listRecords(ctx, 'enterprise', { limit: 100 });
      expect(enterprises).toHaveLength(8);
    });

    await db.close();
  });

  it('seeds any other slug with 1 enterprise and 1 attestation event', async () => {
    const db = await setupTestDb('some-other-pod');
    const manifest = { ...boulderManifest, identity: { ...boulderManifest.identity, slug: 'some-other-pod', did: 'did:web:example.org:dids:some-other-pod' } };
    await withTestPod(db, 'some-other-pod', manifest, async (ctx) => {
      await seedDemoRecords(ctx);
      const { rows: enterprises } = await listRecords(ctx, 'enterprise', { limit: 100 });
      expect(enterprises).toHaveLength(1);
      const { rows: events } = await listRecords(ctx, 'event', { limit: 100 });
      expect(events).toHaveLength(1);
      expect(events[0]?.record.attestation).toBe(true);
    });
    await db.close();
  });
});
