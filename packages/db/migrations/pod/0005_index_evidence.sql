-- Trust index: bind endorsement postings to the VEC that backs them
-- (services/trust-index, Task 7 fix round 3).
--
-- evidence_digest = digestMultibase(vec) of the endorsement credential offered
-- as evidence; a VEC can be counted at most once per poster.
-- endorser_did    = the verified VEC issuer; the scorer counts at most one
-- endorsement per (endorser, poster) pair (the most recent).

ALTER TABLE index_postings ADD COLUMN IF NOT EXISTS evidence_digest text;

ALTER TABLE index_postings ADD COLUMN IF NOT EXISTS endorser_did text;

CREATE UNIQUE INDEX IF NOT EXISTS index_postings_evidence_uq
  ON index_postings (poster_did, evidence_digest)
  WHERE evidence_digest IS NOT NULL;
