import type { Db } from '@passport/db';

/**
 * Trust-index side tables in the pod schema. `edge_commitments` has no poster
 * column (commitments are salted hashes shared by both parties), so the index
 * records who opted each commitment in (`index_postings`) and the optional
 * opt-in adjacency used for seed-hop distance (`index_links`).
 *
 * Applied idempotently by the service inside the caller's `withPod` scope.
 * Candidate to fold into `packages/db/migrations/pod/0002_trust_index.sql`.
 */
export const TRUST_INDEX_POD_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS index_postings (
     commitment text NOT NULL,
     poster_did text NOT NULL,
     witnessed boolean NOT NULL DEFAULT false,
     weighted boolean NOT NULL DEFAULT false,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (commitment, poster_did)
   )`,
  `CREATE INDEX IF NOT EXISTS index_postings_poster_idx ON index_postings (poster_did, created_at)`,
  `CREATE TABLE IF NOT EXISTS index_links (
     from_did text NOT NULL,
     to_did text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (from_did, to_did)
   )`,
];

/** Creates the trust-index tables in the current (pod-scoped) search_path if missing. */
export async function ensureIndexTables(db: Db): Promise<void> {
  const rows = await db.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name IN ('index_postings', 'index_links')`,
  );
  if (Number(rows[0]?.n ?? 0) === 2) return;
  for (const statement of TRUST_INDEX_POD_SQL) await db.query(statement);
}
