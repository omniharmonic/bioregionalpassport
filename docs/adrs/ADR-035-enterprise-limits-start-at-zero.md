# ADR-035 — Enterprise credit limits start at zero and are steward-set; bands come only from root pod-issued VACs

**Status:** accepted · ruled during implementation (`.superpowers/sdd/mvp/progress.md`, Task 14a review)

## Context

The first gateway gave a new enterprise account a limit of the owner's band × 3. It read bands from any VAC the caller presented, including forwarded ones (see ADR-034). Review found the limit unbounded: one member could open several enterprises, or collect forwarded limit VACs, and create credit capacity that no steward approved. In a mutual-credit system that is money creation without governance.

## Decision

Enterprise accounts open with limit 0. Only a steward sets an enterprise's limit, and the steward exposure view shows it. A member account's limit comes from the highest `credit:limit:<band>` among the member's own root VACs: pod-issued, not forwarded, verified, not revoked. Staff are an allow-list of active `merchant_staff` rows, not anyone holding a forwarded `pay:receive`. The limit routes take `{ credentials }` or `{ presentation }` so the gateway can check the root VACs itself.

## Consequences

A new enterprise can receive payments but cannot go negative until a steward acts. That adds one step to merchant onboarding and is the intended governance point. Limits are set when a VAC is presented. They do not lower automatically when the VAC expires or is revoked, which is a recorded follow-up. The steward exposure view is the control until then.
