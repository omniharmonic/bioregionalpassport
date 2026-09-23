-- Pod VTA: every issued witness credential (VWC), keyed by its digest, so the
-- convener who witnessed a relationship can recover a lost response
-- (services/pod-vta, Task 8 follow-up). witness_refs holds only the digest.

CREATE TABLE IF NOT EXISTS vta_witness_credentials (
  digest text PRIMARY KEY,
  vwc jsonb NOT NULL
);
