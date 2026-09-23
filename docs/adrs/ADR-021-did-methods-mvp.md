# ADR-021 — `did:key` / `did:web` for MVP instead of `did:peer:4` / `did:webvh` / `did:plc`

**Status:** accepted · MVP scope (see `docs/plans/2026-09-22-mvp-plan.md` §1, §2)

## Context

The build set (B2 §4.2, B3 §1) specifies `did:peer:4` for wallet personas, `did:webvh` for pods, groups and the platform, and `did:plc` for the one public, ATProto-anchored identifier. Those methods buy verifiable DID-log history, mediator-free peer exchange and a public directory identity, but each needs infrastructure the MVP does not yet have: a `did:webvh` log server, a DIDComm mediator, and an ATProto PDS. Building all three before anything else is provable would delay the first working pod past the point of learning anything from it.

## Decision

For MVP, personas and pairwise identifiers are `did:key` (Ed25519, multicodec `0xed01`), with `credentialSubject.bioregionScope ∈ {"public","directed","pairwise"}` carrying the correlation-scope information that `did:peer`/`did:plc` would otherwise encode structurally. Pods, groups and the platform are `did:web`, hosted at `https://<PLATFORM_DOMAIN>/dids/<slug>/did.json`, with a resolver that also accepts a static document map for tests. The resolver interface (`resolve(did) → DidDocument`) is method-agnostic by construction, so `did:webvh`, `did:peer` and `did:plc` are additive follow-ups, not a rewrite.

## Consequences

`did:web` documents are mutable at the platform's discretion and carry no independent history the way a `did:webvh` log would — pod sovereignty (ADR-15 in the build set) is deferred to the export/self-host runbook rather than proven by DID history today. `did:key` personas have no portable log either; recovery relies entirely on the wallet's backup/Shamir-share mechanism (`packages/credential-core`), not on rotating a DID document. Every credential-core builder and the verifier SDK already carry `bioregionScope`, so re-pinning to `did:peer:4` / `did:plc` later is a resolver and key-derivation change, not a credential-shape change.
