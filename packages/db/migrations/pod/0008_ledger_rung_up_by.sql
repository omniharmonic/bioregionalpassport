-- Circulation (services/cc-gateway, Task 14a fix round 1): who rang up a
-- payment request, so a staff member can read the receipts of the sales they
-- rang up (and only those) without seeing the rest of the enterprise's ledger.
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS rung_up_by text;
