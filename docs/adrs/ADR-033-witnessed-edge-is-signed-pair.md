# ADR-033 — A witnessed edge is a signed relationship pair; the pod signs the VWC for the convener

**Status:** accepted · ruled during implementation (`.superpowers/sdd/mvp/progress.md`, Task 8 fix rounds 1–3 and follow-up; final review must-fix 1)

## Context

A witness credential (VWC) says that a convener saw a relationship at an attestation event, and it gates admission and trust tiers. Task 8's reviews found four problems. One VWC admitted unlimited applicants. A single VRC half was enough for a witness, so one person could assert a relationship alone. The same pair could be witnessed again and again, and the index would count each as a separate edge and event. A convener could witness their own relationship. The final review found a fifth: witness results are posted on a public relay channel, so any member could compute the VWC digest and claim it at the trust index. That lifted them toward T2 and used up one of the real pair's two claim slots.

## Decision

The witnessed edge is the VRC pair. `witnessEdge` needs both signed halves, verifies both proofs, and checks that the halves mirror each other between two distinct DIDs. The server derives `edgeParties` and a sorted `pair_digest`, so both people must have signed. The pod VTA signs the VWC (`issuer = pod DID`, `credentialSubject.witnessedBy = convener`) because the server does not hold the convener's key. It first checks that the convener's session carries `vwc:issue` and that they are among the event's conveners. A pair is witnessed at most once per pod (`witness_refs.pair_digest` is unique). A convener cannot witness their own relationship (`SELF_WITNESS`). The same convener gets the stored VWC back on a retry. A VWC admits at most its two edge parties (`witness_refs.used_by`). The trust index credits a `witnessRef` only when the poster is in the stored credential's `credentialSubject.edgeParties` (`vta_witness_credentials`). Anyone else is refused with 400 `NOT_AN_EDGE_PARTY`. The two-claimant cap stays.

## Consequences

The wallet must send both halves when asking for a witness. Pod-signed VWCs mean a verifier trusts the pod's check of the convener, not the convener's own key. Convener-signed VWCs over DIDComm are the follow-up. Witness rows from before migration 0010 have no stored credential and cannot be claimed at the index. Peer witnessing without an event (Task 21) keeps the pair rule.
