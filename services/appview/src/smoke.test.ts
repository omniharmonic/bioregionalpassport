import { describe, expect, it } from 'vitest';
import { smokeRecord } from './smoke.js';
import { getRecord } from './records.js';
import { setupTestDb, withTestPod, boulderManifest } from './testHelpers.js';

describe('smokeRecord', () => {
  it('writes, reads, and deletes a throwaway place record authored by the pod', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      const result = await smokeRecord(ctx);
      expect(result.ok).toBe(true);
      expect(result.detail).toContain('org.bioregion.place');

      const rkey = result.detail.split('/').pop()!;
      expect(rkey.startsWith('smoke-')).toBe(true);

      // The record must be gone after the smoke test completes.
      const gone = await getRecord(ctx, 'place', rkey);
      expect(gone).toBeNull();
    });
    await db.close();
  });

  it('accepts optional helpers without using them', async () => {
    const db = await setupTestDb('boulder');
    await withTestPod(db, 'boulder', boulderManifest, async (ctx) => {
      const result = await smokeRecord(ctx, { signer: {}, resolver: {} });
      expect(result.ok).toBe(true);
    });
    await db.close();
  });
});
