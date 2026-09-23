import type { Db } from '@passport/db';

/**
 * The trust-index tables (`index_postings`, `index_links`) are created by the
 * pod migration `packages/db/migrations/pod/0002_trust_index.sql`, applied by
 * `migratePod` / `createTestPod`.
 *
 * @deprecated No-op kept for one release so existing callers do not break; the
 * service no longer runs DDL at request time. Remove after the next release.
 */
export async function ensureIndexTables(_db: Db): Promise<void> {
  // intentionally empty
}
