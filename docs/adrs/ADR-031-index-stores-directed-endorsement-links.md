# ADR-031 — The trust index stores directed endorsement links for evidence-bound weighted vouches

**Status:** accepted · ruled during implementation (`.superpowers/sdd/mvp/progress.md`, Task 7 review)

## Context

The build set's trust index (B3 §5) holds only salted edge commitments. It never holds who vouched for whom, so the index learns nothing about the social graph beyond counts. Task 7's first scorer took a self-asserted `counterparty` DID on each commitment and used it for the weighted-endorsement count and for the seed-hop distance. Review found this let anyone forge the T2 gates: a member could name any T2 member as their endorser without that member ever signing anything. Weighting and hop distance need a real, verifiable endorser, and computing hops needs some adjacency.

## Decision

A commitment is weighted, and adds a hop link, only when it carries `evidence.vec`: a signed StatementCredential `dtg:endorses` whose subject is the poster, whose scope matches the commitment, whose proof verifies, and whose issuer is a pod member standing at T2 or above (governance tier, or a current PEP effective tier, per ADR-037). For each such weighted endorsement the index stores one directed row `issuer → poster` in `index_links`. That table is the seed-hop adjacency. Each VEC counts once per poster (`evidence_digest` is unique per poster, and reuse is refused with `DUPLICATE_EVIDENCE`), and each endorser counts once per poster. The schema rejects a bare `counterparty` field.

## Consequences

This is a documented privacy deviation from B3 §5. For every opted-in weighted endorsement the index holds two directed DIDs as well as the salted commitment, so an operator with database access can see who vouched for whom among members who opted in. Unweighted endorsements and witnessed edges still store no DIDs. The wallet must attach the VEC to the commit to get weight. Moving back to link-free hops needs a private-set or ZK hop proof: a new evidence type behind the same `POST /commit` shape.
