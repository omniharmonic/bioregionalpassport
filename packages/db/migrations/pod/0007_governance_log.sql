-- Governance audit log (services/pod-vta, Task 8 fix round 2).
-- One row per change of `members.tier` (the governance tier): steward
-- decisions, operator/bootstrap paths and the T1 admission floor.

CREATE TABLE IF NOT EXISTS governance_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_did text NOT NULL,
  previous_tier text,
  new_tier text NOT NULL,
  by_did text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS governance_log_subject_idx ON governance_log (subject_did, created_at);
