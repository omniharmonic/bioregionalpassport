-- A relationship (VRC pair) is witnessed at most once per pod
-- (services/pod-vta, Task 8 fix round 3; numbered 0009 because 0008 was taken). pair_digest = edgePairDigest(vrcA, vrcB):
-- digestMultibase({ a, b }) over the two halves' digests sorted ascending.

ALTER TABLE witness_refs ADD COLUMN IF NOT EXISTS pair_digest text;

CREATE UNIQUE INDEX IF NOT EXISTS witness_refs_pair_digest_uq
  ON witness_refs (pair_digest)
  WHERE pair_digest IS NOT NULL;
