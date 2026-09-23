# Bioregional Passport — Build & Implementation Plan

**Build set B4 of 4 · v1.0 draft · 22 September 2026**
**Author:** Benjamin Life (@omniharmonic)
**Consolidates:** doc 03 §7 phases, doc 05 §7 G0–G5, doc 06 §14. Weeks are from project start (target: week 1 = 6 October 2026).
**Companions:** B1 PRD · B2 Technical Architecture · B3 Protocol & Schema Reference

---

## 1. Delivery principles

1. **Tenant zero before Boulder.** Multi-tenancy is proven by a synthetic pod in CI from week 3 and gated at week 12; nothing ships to Boulder that hasn't provisioned for tenant zero.
2. **Ceremony first.** The offline attestation ceremony on two phones is the first vertical slice; everything else hangs off it.
3. **Pin, don't chase.** DTG WD02 and Credo 0.6 are pinned; upgrades are deliberate, logged, and tested against conformance vectors.
4. **Counsel and steward before counter.** Circulation G0 runs in parallel with the trust core, not after it.
5. **Ship on the standard's disclosure path;** privacy upgrades (proof sets, ZK) are a track, not a blocker.

## 2. Repository and tooling

Monorepo (`pnpm` + Turborepo), TypeScript strict, Node 22, Expo SDK current LTS.

```
apps/        mobile · web-grants · web-directory · web-steward · web-operator
packages/    credential-core · verifier-sdk · lexicons · vocab · ui-kit (themeable) · tenant-config · pod-client
services/    pod-vta · trust-index · round · cc-gateway · pos-adapter · appview · control-plane
infra/       terraform (Neon, object storage, KMS, DNS, cluster) · docker · did-webvh-server · mediator
docs/        this build set · dtg-compat.md · adrs/ · runbooks/
```
CI: lint/typecheck/test per package; conformance vectors; tenant-zero provisioning job nightly and on release; Detox/Maestro e2e for the ceremony on Android + iOS emulators; EAS builds on tags. Licence: Apache-2.0 for code; CC-BY for docs and vocabularies. GitHub account per the operating guide.

## 3. Workstreams

| WS | Name | Owner (role) | Scope |
|---|---|---|---|
| W1 | Credential core & wallet | Mobile lead | `credential-core`, Credo fork/patch, DID methods, ceremony, storage, recovery, wallet UI |
| W2 | Pod services | Backend lead | pod-vta/PEP, trust index, status lists, mediator, DIDComm |
| W3 | Platform & tenancy | Backend lead + DevOps | control plane, CLI, manifests, `did:webvh` hosting, schema-per-pod, registry, tenant zero |
| W4 | Open records & map | Full-stack | lexicons, PDS, AppView, Twin links, directory/map UI, schema.org |
| W5 | Grants | Full-stack | round service, QV, pseudonyms, steward console |
| W6 | Circulation | Backend + Steward | cc-node/gateway, Merchant Mode, POS adapters, exports, steward console, kill-criteria board |
| W7 | Security, privacy, compliance | Lead engineer + counsel | threat model, KMS, audits, counsel opinion, disclosure statements |
| W8 | Design & theming | Designer | ui-kit tokens, manifest-driven theming, white-label pipeline, pod copy |
| W9 | Ecosystem & governance | Benjamin | DTGWG/OpenVTC participation, IIW pilot, governance templates, trust policy, name |

## 4. Phases and milestones

### Phase 0 — Foundations (weeks 1–4) · exit: M0
- W3: monorepo, CI, infra bootstrap (Neon, storage, KMS, DNS), `did:webvh` server, control-plane skeleton, manifest schema + validator, `passport bioregion create` v0 (DID + schema + manifest).
- W1: `credential-core` v0 on Credo 0.6: resolvers (webvh/peer/key/plc), DI `eddsa-jcs-2022` sign/verify (patch), DTG types + digests, unit vectors.
- W8: ui-kit tokens; manifest-driven theme provider; Boulder and tenant-zero manifests.
- W9: Boulder pod DID minted (portable, pre-rotation, witnesses); governance and trust-policy templates drafted; IIW session proposed.
- **M0 exit:** `passport bioregion create tenant-zero` succeeds in CI; a VMC pair signs and verifies in tests; app boots themed from a manifest.

### Phase 1 — Trust core (weeks 5–8) · exit: M1
- W1: ceremony end-to-end offline on two phones (OOB QR → DIDComm v1 → VRC pair → VWC request); wallet screens (connections, vouch, credentials); recovery v0 (encrypted backup; social shares).
- W2: pod-vta: membership apply/grant/ack; PEP v0 issuing VACs from a hand-set tier; audit log; index v1 with explanation; DIDComm mediator deployed.
- W3: tenant scoping (`X-Pod`), schema migrations across pods, registry v0.
- W7: threat model v1; KMS wiring; `did:plc` assertionMethod test.
- Verifier SDK v0 with `verifyDTG` + vectors; Free School integration branch.
- **M1 exit:** two phones form a witnessed edge offline, sync, receive a VMC pair and T1 VACs; Free School accepts the pair at the door in staging; 500-edge wallet benchmark < 2 s.

### Phase 2 — Open records & map (weeks 6–10) · exit: M2
- W4: lexicons published; community PDS with per-pod handle domains; AppView with `bioregion` scoping and materialised views; map/directory UI; Twin `resolve_point` integration; schema.org export; `identity.link` records.
- W8: pod theming across web apps; per-pod domains.
- **M2 exit:** Boulder enterprises, events and groups visible on the map; tenant-zero AppView shows only its records.

### Phase 3 — Tenant zero gate (weeks 11–12) · exit: M3 (hard gate)
- W3: full provisioning path (DID, schema, cc-node, AppView views, mediator route, domains, registry entry, templates, anchor VICs, smoke test) < 60 min; export/verify commands.
- W8: white-label build profile generated from manifest; TestFlight/Play internal build for tenant zero.
- W1/W2: multi-pod wallet (join second pod, persona choice); cross-tenant refusal tests.
- **M3 exit:** a fresh engineer provisions tenant zero from the manifest with no code change; a resident joins Boulder and tenant zero in one wallet; cross-pod credential presentation is refused.

### Phase 4 — Grants v1 (weeks 9–14) · exit: M4
- W5: round service; per-round pseudonyms; QV tally; steward review; `project` records; group voting via VDC chain; round steward console.
- **M4 exit:** dry-run round in staging with ≥ 30 test voters; verifiable tally reproduced from published ballots. First Boulder round scheduled Q1 2027.

### Phase 5 — Circulation G0–G3 (weeks 8–18) · exits: G0…G3
- G0 (8–11): counsel engaged (barter-exchange status, cashback, split-tender tax, exclusions); steward funded; unit and limits closed; commitment record schema; W-9 flow.
- G1 (10–13): cc-node per pod under trunk; gateway with VAC-based accounts/limits; Merchant Mode v0 (QR both grammars, rules, exposure dashboard, offline allowance, receipts); Ring 1–2 seeding by steward; brokerage queue v0.
- G2 (12–14): Ring 3 no-POS pilot; `pay.request` schema published; first balance circle.
- G3 (15–18): Square adapter validated on a real merchant account; exports; 1099-B totals; 25 enterprises; kill-criteria board.
- **Exit per gate:** doc 05 §7.

### Phase 6 — Second real pod + G4 (weeks 19–24) · exit: M6
- W3/W9: Front Range pod provisioned for a real community (candidate identified by week 12); its own manifest, anchors, governance, trust policy, events.
- W6: Clover custom tender; Shopify manual payment; anchor institution live.
- W2/W3: TRQP registry public; second mediator.
- **M6 exit:** second pod has ≥ 1 attestation event and ≥ 20 members; re-spend ≥ 60% in Boulder; registry answers authorization queries for both pods.

### Phase 7 — Harden (weeks 18–24, parallel) · exit: M7
- Status lists; OID4VP for external verifiers; proof-set-ready issuer; index commitments hardened; Python Verifier SDK; Rust VTI evaluation for pod-vta; Credit Commons beta migration plan (G5); external security review; DTG re-pin to latest tagged draft with vector diff.

## 5. Team and effort

| Role | FTE | Months | Notes |
|---|---|---|---|
| Product lead / architect (Benjamin) | 0.5 | 6 | W9, decisions, governance, ecosystem |
| Lead engineer (backend/platform) | 1.0 | 6 | W2, W3, W7 |
| Mobile engineer | 1.0 | 6 | W1, ceremony, wallet, white-label |
| Full-stack engineer | 1.0 | 6 | W4, W5, consoles |
| Designer (product + theming) | 0.5 | 6 | W8 |
| Circulation steward (Boulder) | 1.0 | from week 8, 12+ months | W6 operations; non-negotiable |
| DevOps (fractional) | 0.25 | 6 | infra, CI, tenant zero |
| Counsel (Colorado) | fixed fee | weeks 8–11 | G0 opinion |
| Second-pod steward | 0.5 | from week 16 | Phase 6 |

≈ 26 engineering FTE-months over six months plus stewarding. If the team is smaller, hold the order: Phase 0–1 → 3 → 2 → 5 (G0 in parallel) → 4 → 6 → 7; do not skip Phase 3.

## 6. Environments, release and operations

- `dev` per engineer (tenant zero local); `staging` (tenant zero + Boulder mirror; TestFlight/Play internal); `prod` (Boulder; later pods).
- Release train: fortnightly app releases after M1; services continuous with migrations run across all pod schemas by one runner (tenant zero first as canary).
- Runbooks: provision pod; rotate pod key; add anchor; re-witness after revocation; ledger dispute; POS reconciliation backlog; kill-criteria pause; pod export/exit.
- On-call: lead engineer for services; steward for ledger/merchant issues; escalation to pod anchors for governance.

## 7. Testing and acceptance

| Layer | What |
|---|---|
| Unit | credential-core (types, digests, DI proofs, attenuation, chain rules); scorer; manifest validator |
| Conformance | Verifier SDK vectors (B3 §10); DTG re-pin diff; VC 1.1/2.0 acceptance; SD-JWT/mdoc presentations |
| E2E | Ceremony offline on emulators; join two pods; pay two-leg in staging against Square production account (G3); grants dry-run; provisioning from manifest |
| Load | 500-edge wallet; 5k-member index recompute < 5 min; 100 tx/min gateway |
| Security | Threat-model review at M1 and M6; external review in Phase 7; secrets scan; dependency audit |
| Privacy | No cross-pod query path (static analysis rule + integration test); index stores only commitments; firehose contains no membership |
| Acceptance | Each milestone's exit criteria signed off by Benjamin; Circulation gates by steward + counsel |

## 8. Launch checklists

**Boulder trust core (M1→public beta):** governance published; disclosure statement; trust policy signed; anchors named; three conveners hold `event:convene`; recovery tested; explanation payloads reviewed for plain language; support channel; app store listing (shared app).
**Circulation (G1→G3):** counsel opinion; steward funded; limits published; W-9 capture; dispute process; Ring 1–2 seeded; exposure dashboard; kill-criteria board; Square validated.
**Second pod (M6):** manifest signed; DID witnessed; governance and policy adapted (not copied); steward named; first event scheduled; registry entry; white-label decision recorded.

## 9. Risk register (build-level)

| # | Risk | Likelihood | Impact | Trigger / response |
|---|---|---|---|---|
| 1 | Credo VC 2.0 DI PR unmerged at week 4 | High | Med | Maintain patch branch; upstream PR; isolate behind `credential-core` |
| 2 | DTG WD03 breaks digest or scope semantics | Med | Med | Compat log; vectors; re-pin only at milestones |
| 3 | DIDComm v2 slips | High | Low | v1 for ceremony; mediator supports both |
| 4 | Second real pod not ready by week 19 | Med | High | Identify candidate by week 12; fallback: Longmont/Lyons via Spirit of the Front Range; tenant zero still gates |
| 5 | Square production validation fails | Med | High | G3 pulls Clover forward; no-POS merchants continue |
| 6 | Counsel flags transmitter risk | Low | Very high | Kill criterion; Circulation pauses; trust/grants unaffected |
| 7 | Steward not funded | Med | Very high | Circulation does not launch (C5); pod's first grants proposal funds it |
| 8 | White-label store approval delays | Med | Low | Shared app is the default; white-label optional |
| 9 | Team below plan | Med | High | Hold phase order; drop Phase 7 items; never drop Phase 3 |
| 10 | Name unresolved at public beta | High | Low | Pods self-name; platform name decided by M2 |

## 10. Decisions required in the first two weeks

1. Platform name and pod self-naming policy (B1 §13.1).
2. Confirm Credo/Bifold fork strategy and the `credential-core` interface freeze.
3. Boulder anchors (T4) and initial conveners (T3); seed set.
4. Second-pod candidate shortlist and outreach owner.
5. Counsel engagement letter.
6. Steward funding source (grant vs. first round).
7. Developer accounts for app stores (platform-owned vs. pod-owned).

## 11. Sources of truth

B1 PRD (product), B2 Architecture (design), B3 Protocol & Schema (wire contracts), this plan (delivery); docs 01–06 for rationale; `docs/adrs/` for ADR 1–20; `docs/dtg-compat.md` for spec pinning.
