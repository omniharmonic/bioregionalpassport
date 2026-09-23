-- Trust index side tables (services/trust-index, MVP plan Task 7).
--
-- `edge_commitments` has no poster column (a commitment is a salted hash both
-- parties may post), so the index records who opted each commitment in.
--
-- MVP privacy deviation (recorded by the ADR task): besides salted
-- commitments, the index stores, for each opted-in endorsement backed by a
-- verified VEC from a member at T2 or above, one link row of two directed DIDs
-- (endorser -> endorsed). Those rows are the only input to seed-hop distance.

CREATE TABLE IF NOT EXISTS index_postings (
  commitment text NOT NULL,
  poster_did text NOT NULL,
  witnessed boolean NOT NULL DEFAULT false,
  weighted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (commitment, poster_did)
);

CREATE INDEX IF NOT EXISTS index_postings_poster_idx ON index_postings (poster_did, created_at);

CREATE TABLE IF NOT EXISTS index_links (
  from_did text NOT NULL,
  to_did text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_did, to_did)
);
