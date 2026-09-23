-- Peer witnessing (services/pod-vta, Task 21a). A witness may witness a relationship without a scheduled
-- event: POST /witness creates an ad-hoc Trust Task row in `events` with kind = 'meeting' (id 'meet-<tid>').
-- Existing rows are gatherings, so the column defaults to 'event'. Meetings are hidden from the public
-- events list.

ALTER TABLE events ADD COLUMN IF NOT EXISTS kind text DEFAULT 'event';

UPDATE events SET kind = 'event' WHERE kind IS NULL;

-- The witness's tier (GREATEST(members.tier, members.effective_tier)) when they witnessed, so admission can
-- apply policy.admission.witnessTier to the tier held at witness time rather than today's.
ALTER TABLE witness_refs ADD COLUMN IF NOT EXISTS witness_tier text;

-- Steward review of witness volume (FR-TR-3 anomaly input): witness_refs grouped by witness over a window.
CREATE INDEX IF NOT EXISTS witness_refs_convener_created_idx ON witness_refs (convener_did, created_at);
