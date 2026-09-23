/** Test-only helpers for building a `PodContext` on PGlite. Not part of the public API. */
import { createTestDb, createTestPod, withPod, type Db } from '@passport/db';
import { boulderManifest, tenantZeroManifest, defaultTrustPolicy, type BioregionManifest } from '@passport/tenant-config';
import type { PodContext, SessionClaims } from './kit.js';

export { boulderManifest, tenantZeroManifest };

export async function setupTestDb(...slugs: string[]): Promise<Db> {
  const db = await createTestDb();
  for (const slug of slugs) {
    await createTestPod(db, slug);
  }
  return db;
}

export function buildCtx(
  tx: Db,
  slug: string,
  manifest: BioregionManifest,
  now: () => Date = () => new Date('2026-09-22T12:00:00.000Z'),
): PodContext {
  return {
    slug,
    podDid: manifest.identity.did,
    db: tx,
    manifest,
    policy: defaultTrustPolicy(manifest.identity.did),
    now,
    platformDomain: 'bioregionalpassport.org',
  };
}

/** Runs `fn` inside a `withPod` transaction, passing a ready `PodContext`. */
export async function withTestPod<T>(
  db: Db,
  slug: string,
  manifest: BioregionManifest,
  fn: (ctx: PodContext) => Promise<T>,
  now?: () => Date,
): Promise<T> {
  return withPod(db, slug, async (tx) => fn(buildCtx(tx, slug, manifest, now)));
}

export function makeSession(
  subject: string,
  tier: string,
  authorities: string[] = [],
): SessionClaims {
  return { subject, pod: '', tier, authorities };
}
