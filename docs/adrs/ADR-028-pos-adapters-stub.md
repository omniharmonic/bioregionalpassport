# ADR-028 — POS adapters are interface-only stubs instead of a live Square integration

**Status:** accepted · MVP scope

## Context

The build set's circulation gate (B4 §8) requires a validated Square integration before real payment volume goes live: OAuth, a production Square account, and a reconciliation path between Square's own transaction records and the pod's ledger. That integration has its own approval process and account requirements that are independent of whether the mutual-credit gateway, merchant mode and steward console work correctly.

## Decision

For MVP, `services/pos-adapter` defines the adapter interface only, with a single working implementation: a manual-tender adapter that records a cash/card-plus-credit split entered by the merchant, plus a reconcile queue for anything not auto-matched. Square OAuth and any other point-of-sale integration are follow-ups behind the same interface.

## Consequences

Merchant Mode works end to end for MVP (ring up a sale, propose a credit share, generate the payment request, tender manually), but nothing in the MVP automatically reconciles a Square-side transaction against a ledger entry — every reconciliation is manual until a real adapter exists. Because the manual adapter already implements the full interface, adding Square later is a second adapter implementation, not a change to `cc-gateway`, the reconcile queue's shape, or the merchant/steward UI that consumes it.
