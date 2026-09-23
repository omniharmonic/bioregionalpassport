# ADR-023 — Native mutual-credit ledger instead of a Credit Commons node per pod

**Status:** accepted · MVP scope

## Context

The build set (B2 §4.6, B4 ADR-20) calls for a dedicated Credit Commons node per pod, nested under one platform trunk, so that inter-pod clearing becomes possible later without money ever sharing tables across bioregions. Running a Credit Commons node is a real deployment (its own process, its own state, its own upgrade path) that duplicates functionality the MVP can express directly in the pod's own Postgres schema while there is exactly one pod's economics to prove out.

## Decision

For MVP, the ledger is a native mutual-credit ledger living in the pod's own schema (`pod_<slug>.accounts`, `.ledger_entries`, `.commitments`, `.pos_grants`, `.disputes`), exposed by `services/cc-gateway` through the same gateway API B3 §9 defines (`/accounts/open`, `/pay/request`, `/pay/authorize`, `/reconcile/pending`, `/steward/exposure`, `/exports/transactions.csv`, merchant and disputes routes). Inter-pod clearing is disabled by policy — there is no cross-pod query path for ledger data, matching the schema-per-pod isolation every other table already has (B2 §2.2). The Credit Commons node is the named migration target once a second pod needs to trade with the first.

## Consequences

Every pod's credit is fully isolated today, which is strictly more conservative than the build set's design, not less — the risk this ADR accepts is rework, not premature coupling. Because `services/cc-gateway` exposes the B3 §9 surface exactly, migrating a pod's ledger data into a Credit Commons node later is an export/import behind the same gateway routes; nothing above the gateway (wallet, merchant mode, steward console) needs to change. Nothing in the MVP currently exercises inter-pod trade, so that part of the eventual trunk topology is unvalidated until a second pod exists.
