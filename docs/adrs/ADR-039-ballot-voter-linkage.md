# ADR-039 — Ballot–voter linkage via `voter_hash`, and the group-ballot challenge

**Status:** accepted · ruled during implementation (`.superpowers/sdd/mvp/progress.md`, Task 13a review) · follow-up: HMAC `voter_hash`

## Context

Quadratic-voting ballots in `services/round` are signed by a per-round voting key (`voterKey`), not by the member's DID, so the published ballots do not name voters. The round still has to enforce one ballot per voter (last ballot wins until close) and one ballot per group for group votes. Group votes are cast by a member acting through a delegation (ADR-029), and the group's presentation needs replay protection that fits a ballot flow with no separate challenge endpoint.

## Decision

A ballot is linked to its voter only through `ballot_voters.voter_hash = sha256(roundId ‖ principal)`. The principal is the session subject for a personal vote, or the delegating group (`delegatedFor`) for a group vote. A later ballot with the same hash replaces the earlier one. A voting key already used by a different hash is refused. The personal path needs `round:vote` on the session and refuses a delegated session. The group path sends `linkage.presentation`, verified with `verifyDTG`: delegation allowed, `round:vote` required, `challenge` = the round id, `domain` = the pod host. The presentation's holder must equal the session subject (`HOLDER_MISMATCH`), and the group votes at T2 weight. The ballot body stays `{ ballot, linkage? }`, and the tally publishes `votes` and a `verifiable.ballotsHash`.

## Consequences

The group-ballot challenge is not fresh per request, unlike ADR-030's default. Only the same session holder can replay it, only within that round, and a replay only replaces that group's own ballot, which the member could do anyway. `voter_hash` is an unsalted hash of public inputs. Anyone who holds the database and knows the round id can test a candidate DID against it, so ballot secrecy relies on database access control. The follow-up is to key it: `HMAC(podSecret, roundId ‖ principal)`, with the key held beside the pod signing key. It is a drop-in change to `voterHash` plus a re-hash of open rounds.
