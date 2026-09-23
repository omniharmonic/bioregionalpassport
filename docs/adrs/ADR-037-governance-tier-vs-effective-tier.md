# ADR-037 — Governance tier vs PEP effective tier; steward cap below T3; governance log

**Status:** accepted · ruled during implementation (`.superpowers/sdd/mvp/progress.md`, Task 8 fix rounds 1–2; final review must-fix 3)

## Context

`members.tier` first held whatever the PEP last decided, so a PEP recomputation could overwrite a governance decision, such as a steward seat or an anchor. The trust index also reads a "recorded tier" to satisfy governance requirements (`electedByGovernance`, `namedInGovernance`). If that tier came from the PEP, the index would feed its own output back in as a governance fact. Separately, the steward tier route could demote anchors, and nothing recorded who changed what. After the split, the final review found that the index weighted endorsements by `members.tier` only, so members at an effective T2 could not give weighted vouches.

## Decision

`members.tier` is the governance tier only. It is written by bootstrap, steward and operator decisions and by the T1 admission floor, and every change is logged in `governance_log` (who, from, to, why). `members.effective_tier` / `effective_until` are written only by the PEP, from the index recommendation, the governance floor and the VACs still held. The steward tier route may set T0–T2 only, only for members below T3 and below the caller. Raising anyone to T3 or above is reserved for the bootstrap and operator paths. The index's governance requirements read the governance tier only. Vouch weighting reads the standing tier: the higher of the governance tier and an effective tier whose `effective_until` is unset or in the future.

## Consequences

A PEP run can never erase a governance decision, and the index cannot promote itself into governance requirements. Stewards cannot create or demote other stewards. That needs the operator or a governance process outside the app. Every governance change is auditable per member. Two tier columns mean every reader must choose one deliberately; the rule is "governance for governance facts, standing tier for trust weight".
