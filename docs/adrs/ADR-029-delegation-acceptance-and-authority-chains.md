# ADR-029 — Delegation acceptance credential and re-checkable authority chains

**Status:** accepted · ruled during implementation (`.superpowers/sdd/mvp/progress.md`, Task 1 review)

## Context

B3 §2 defines `DelegationCredential` with a grant half (group → steward, `delegation.scope[]`, `maxDepth`) and an "accepts" half issued on acceptance, but the plan's original `@passport/credential-core` interface (§4.1 as first drafted) only had `checkDelegationChain` treat a grant's own `accepts` field as sufficient proof of acceptance. Code review on Task 1 found this let a group's delegation grant alone imply the steward's consent — nothing required the steward to have signed anything — which breaks the product principle that "consent is structural: no membership or delegation exists without the member's own signature" (B1 §4). Review also found `attenuate`'s subset/depth/expiry rules were enforced only at issuance time, with no way for a verifier to re-derive and check an authority chain independently after the fact.

## Decision

Acceptance is its own signed credential: `buildDelegationAcceptance({steward, group, grantDigest, validUntil})` builds a `DelegationCredential` from the steward back to the group, with `delegation.accepts = digestMultibase(grant)`. `checkDelegationChain(chain, {actor, requiredScope, acceptances, now})` now takes the presentation's full set of acceptance credentials and counts a hop as accepted only when a currently-valid acceptance exists whose issuer is the hop's subject, whose subject is the hop's issuer, and whose `accepts` digest matches that hop — a truthy `accepts` field on the grant itself no longer counts. Separately, `checkAuthorityChain(chain)` re-derives the same attenuation rules `attenuate` enforces at issuance (parent digest, depth against the root's `maxDepth`, action subset, scope match, issuer = parent's subject, validity window nested inside the parent's) so any verifier can independently confirm a presented VAC chain rather than trusting that issuance was honest.

## Consequences

Every steward relationship in the MVP needs two credentials on the wire (the group's grant and the steward's acceptance), and `verifyDTG`/`checkDelegationChain` callers must supply the acceptance set, not just the grant. This is the ceremony-level cost of the "no delegation without the delegate's own signature" principle. `checkAuthorityChain` being independently re-checkable means a compromised or buggy issuer cannot forge a wider authority than the root VAC actually grants and have it accepted on presentation — the verifier SDK, not just `attenuate`, is the enforcement point for attenuation.
