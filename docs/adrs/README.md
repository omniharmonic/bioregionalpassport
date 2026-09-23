# Architecture decision records

Each ADR is one paragraph of context, one of decision, one of consequences, in the voice of the build set's own decision log.

## ADR 1–20 — build set

ADR 1–20 are recorded in the build set itself, not as separate files here:

- **ADR 1–14** — see `docs/build-set/11-passport-technical-architecture.md` and the other B1–B4 documents (product, protocol and delivery decisions predating the MVP session plan).
- **ADR 15–20** — `docs/build-set/11-passport-technical-architecture.md` §9 ("Decision log (new)"):
  - ADR 15 — Pod sovereignty and exit.
  - ADR 16 — Isolation by schema-per-pod, node-per-pod, shared stateless compute.
  - ADR 17 — TypeScript pod VTA/PEP on Credo for v1; Rust VTI evaluated later.
  - ADR 18 — One shared mobile app with runtime manifests; no forks.
  - ADR 19 — Shared lexicon namespace `org.bioregion.*` with a `bioregion` field on every record.
  - ADR 20 — Pods nest under one Credit Commons trunk from day one; inter-pod clearing disabled by policy.

## ADR 21–40 — MVP session (this repository)

Recorded here because they are deviations from, or rulings within, the build set made specifically for the MVP build (`docs/plans/2026-09-22-mvp-plan.md` §2, and the SDD ledger `.superpowers/sdd/mvp/progress.md`).

| ADR | Title |
|---|---|
| [021](./ADR-021-did-methods-mvp.md) | `did:key` / `did:web` for MVP instead of `did:peer:4` / `did:webvh` / `did:plc` |
| [022](./ADR-022-ceremony-transport-qr-http-relay.md) | Ceremony transport is QR + an HTTP relay instead of DIDComm |
| [023](./ADR-023-native-ledger-instead-of-credit-commons-node.md) | Native mutual-credit ledger instead of a Credit Commons node per pod |
| [024](./ADR-024-open-records-in-pod-schema-instead-of-atproto-pds.md) | Open records stored in the pod schema instead of an ATProto PDS/firehose |
| [025](./ADR-025-wallet-is-browser-pwa-not-native-app.md) | Wallet is a browser PWA instead of the Expo mobile app |
| [026](./ADR-026-single-deployable-apps-web.md) | Single deployable (`apps/web`) instead of separate web apps per console |
| [027](./ADR-027-pod-keys-encrypted-at-rest-not-kms.md) | Pod signing keys encrypted at rest with an application key instead of KMS |
| [028](./ADR-028-pos-adapters-stub.md) | POS adapters are interface-only stubs instead of a live Square integration |
| [029](./ADR-029-delegation-acceptance-and-authority-chains.md) | Delegation acceptance credential and re-checkable authority chains |
| [030](./ADR-030-scoped-authorities-and-fresh-challenges.md) | Scoped authority requirements and challenges required by default |
| [031](./ADR-031-index-stores-directed-endorsement-links.md) | The trust index stores directed endorsement links for evidence-bound weighted vouches |
| [032](./ADR-032-wallet-canonical-origin.md) | Wallet canonical origin, platform-wide cookie, and pod-host redirects for wallet-dependent sections |
| [033](./ADR-033-witnessed-edge-is-signed-pair.md) | A witnessed edge is a signed relationship pair; the pod signs the VWC for the convener |
| [034](./ADR-034-forwarded-vacs-carry-only-pay-receive.md) | Forwarded (attenuated) VACs may carry only `pay:receive` |
| [035](./ADR-035-enterprise-limits-start-at-zero.md) | Enterprise credit limits start at zero and are steward-set; bands only from root pod-issued VACs |
| [036](./ADR-036-platform-operator-auth-bearer-only.md) | Platform-scope operator auth is Bearer-only in MVP |
| [037](./ADR-037-governance-tier-vs-effective-tier.md) | Governance tier vs PEP effective tier; steward cap below T3; governance log |
| [038](./ADR-038-challenges-and-relay-in-platform-db.md) | Challenges and the ceremony relay live in `platform.relay_messages` |
| [039](./ADR-039-ballot-voter-linkage.md) | Ballot–voter linkage via `voter_hash`, and the group-ballot challenge |
| [040](./ADR-040-pod-reissue-after-share-recovery-deferred.md) | Pod re-issue after share-only recovery is deferred |

ADR 29–40 are rulings made during implementation and review; most tighten a security or governance boundary, and ADR-031, ADR-039 and ADR-040 record known deviations with named follow-ups.

Every ADR 21–28 deviation is deliberately behind a package or service interface (credential-core, verifier-sdk, the gateway API, the appview lexicon shape) so re-pinning to the build set's original design later — `did:webvh`, DIDComm, a Credit Commons node, an ATProto PDS, the Expo app, split-out services, per-pod KMS, Square — does not require changing the interfaces callers already use.
