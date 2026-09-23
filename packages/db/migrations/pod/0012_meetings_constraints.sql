-- Task 21a fix round 1 (services/pod-vta). 0011_meetings.sql is already applied in production, so the
-- tightening lives here. Idempotent.

-- events.kind: always 'event' or 'meeting' (0011 added it nullable with default 'event').
ALTER TABLE events ALTER COLUMN kind SET DEFAULT 'event';

UPDATE events SET kind = 'event' WHERE kind IS NULL;

ALTER TABLE events ALTER COLUMN kind SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_kind_check' AND conrelid = 'events'::regclass
  ) THEN
    ALTER TABLE events ADD CONSTRAINT events_kind_check CHECK (kind IN ('event', 'meeting'));
  END IF;
END
$$;

-- witness_refs.witness_tier: the witness's tier at witness time ('T0'..'T4'; 'T0' for a non-member).
-- Rows with no recorded tier (they predate 0011, or 0011-era code found no members row) are marked 'legacy';
-- admission falls back to the witness's CURRENT tier for those only (pod-vta membership.ts#checkWitnessTier).
-- New rows default to 'T0', never 'legacy'.
UPDATE witness_refs SET witness_tier = 'legacy' WHERE witness_tier IS NULL;

ALTER TABLE witness_refs ALTER COLUMN witness_tier SET DEFAULT 'T0';

ALTER TABLE witness_refs ALTER COLUMN witness_tier SET NOT NULL;
