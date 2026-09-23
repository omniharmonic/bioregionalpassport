# ADR-034 — Forwarded (attenuated) VACs may carry only `pay:receive`

**Status:** accepted · ruled during implementation (`.superpowers/sdd/mvp/progress.md`, Task 14a review; verifier-sdk fix round 3)

## Context

Attenuation lets a VAC holder forward part of their authority. The one use in B3 is an enterprise owner handing `pay:receive` to staff. Task 14a's review found that forwarded VACs could carry credit-limit authorities (`credit:limit:<band>`), and the gateway then counted them when setting limits. A member could forward their band to an enterprise or a friend and multiply credit capacity without any steward decision.

## Decision

`verifyDTG` accepts an attenuated (forwarded) VAC only when its authorities are exactly `pay:receive`, scoped to an enterprise per ADR-030. Any other action in a forwarded VAC is refused. Credit bands and every other pod-scoped action are read only from root VACs that the pod itself issued to the holder.

## Consequences

Staff delegation for merchant mode still works. No other forwarding use case exists in B3, so none is lost. If a legitimate one appears, it needs a new explicit rule in the verifier SDK and a conformance vector, not a loosening of this one. The rule is covered by the verifier SDK's tests.
