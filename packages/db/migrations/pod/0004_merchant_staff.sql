-- Circulation side tables (services/cc-gateway, MVP plan Task 14).
--
-- merchant_staff: staff grants for an enterprise. The grant itself is an
-- owner-signed attenuated `pay:receive` AuthorityCredential that lives in the
-- staff member's wallet; the gateway records only its digest and validity so
-- owners can list and revoke staff.
--
-- steward_flags: small key/value store for circulation stewards (the manual
-- `counsel` kill-criterion flag, brokerage `match:<needId>` log entries).
--
-- ledger_entries.invoice is unique: an invoice can be requested and paid once.

CREATE TABLE IF NOT EXISTS merchant_staff (
  enterprise_did text NOT NULL,
  staff_did text NOT NULL,
  vac_digest text NOT NULL,
  valid_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (enterprise_did, staff_did, vac_digest)
);

CREATE INDEX IF NOT EXISTS merchant_staff_staff_did_idx ON merchant_staff (staff_did);

CREATE TABLE IF NOT EXISTS steward_flags (
  key text PRIMARY KEY,
  value jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_invoice_uidx ON ledger_entries (invoice) WHERE invoice IS NOT NULL;
CREATE INDEX IF NOT EXISTS ledger_entries_status_created_idx ON ledger_entries (status, created_at);
