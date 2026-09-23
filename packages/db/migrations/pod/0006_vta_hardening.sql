-- Pod VTA hardening (services/pod-vta, Task 8 fix round 1).
--
-- witness_refs.used_by  = DIDs admitted with this witness credential (at most
--                         the two parties of the witnessed edge).
-- members.tier          = the GOVERNANCE tier only (bootstrap, steward/operator
--                         decisions, the initial T1 floor on admission).
-- members.effective_tier / effective_until
--                       = what the PEP decided from the trust index
--                         recommendation, the governance floor and the VACs
--                         still held (FR-TR-2); written only by the PEP.

ALTER TABLE witness_refs ADD COLUMN IF NOT EXISTS used_by jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE members ADD COLUMN IF NOT EXISTS effective_tier text;

ALTER TABLE members ADD COLUMN IF NOT EXISTS effective_until timestamptz;
