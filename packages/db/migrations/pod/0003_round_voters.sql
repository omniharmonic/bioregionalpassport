-- Grants round anti-double-vote binding (services/round, MVP plan Task 13).
--
-- A ballot is published under its per-round pseudonymous `voter_key` only.
-- The link to the member (or, for a group vote, the group) lives here as
-- `voter_hash = sha256(round_id || principal DID)` and is never published:
-- one row per voter per round; a new ballot from the same voter replaces the
-- previous one ("last ballot wins until close").

CREATE TABLE IF NOT EXISTS ballot_voters (
  round_id text NOT NULL,
  voter_hash text NOT NULL,
  ballot_id text NOT NULL REFERENCES ballots(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, voter_hash)
);

-- A per-round voting key belongs to exactly one ballot in the round.
CREATE UNIQUE INDEX IF NOT EXISTS ballots_round_voter_key_idx ON ballots (round_id, voter_key);
