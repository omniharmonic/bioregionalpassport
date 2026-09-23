# ADR-030 — Scoped authority requirements and challenges required by default

**Status:** accepted · ruled during implementation (`.superpowers/sdd/mvp/progress.md`, Task 6 review)

## Context

`pay:receive` (B3 §3) authorizes an enterprise's owner or staff to receive payments, and staff hold it via an attenuated VAC (`attenuate` from the enterprise owner's authority). Code review on Task 6 found the first `verifyDTG` implementation treated `pay:receive` as a single bare scope: any valid `pay:receive` VAC satisfied any gate asking for it, so staff attenuated to receive at one enterprise could pass a `requireAuthority` check at a completely different enterprise's payment gate — the scope carried no enterprise identity. Review also found `verifyDTG` accepted a presentation with no `challenge`/`domain` at all, which makes every valid presentation replayable indefinitely against any gate that does not itself think to generate and check a fresh challenge.

## Decision

`requireAuthority` (and the VP policy) accepts a scoped syntax `<action>@<did>`, e.g. `pay:receive@<enterpriseDid>`; for such an entry, the candidate VAC's `authority.scope` must equal that DID, not just the pod DID. A bare `pay:receive` requirement is refused outright (`MISSING_AUTHORITY`, "This gate needs pay:receive scoped to an enterprise.") rather than silently accepting any enterprise's grant. Separately, `verifyDTG` now requires `policy.challenge` and `policy.domain` to be present and to match the presentation's proof unless the policy explicitly sets `allowReplay: true`; without them the result is `BAD_CHALLENGE`, "This gate requires a fresh challenge." Every gate that verifies a presentation (`pod-vta` session endpoint, `cc-gateway` pay/authorize, round ballots) must therefore issue a challenge (`GET /challenge`) and check it, which they already do per the plan's `POST /api/vta/session` flow.

## Consequences

Every `requireAuthority` caller that means "receive payments for a specific enterprise" must write the scoped form (`pay:receive@<did>`), not the bare action string; `packages/vocab`'s scope list is unchanged, the `@did` suffix is parsed by the verifier SDK, not stored in the vocabulary. Any future gate that skips challenge issuance for convenience must set `allowReplay: true` explicitly and accept that its presentations are then replayable — the default is safe, not silent. Both rulings are exercised by the verifier SDK's conformance vectors (`broadened-attenuation` now uses a scoped `pay:receive@<did>` policy) so a regression on either fails CI.
