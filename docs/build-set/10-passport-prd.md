# Bioregional Passport — Product Requirements Document (PRD)

**Build set B1 of 4 · v1.0 draft · 22 September 2026**
**Author:** Benjamin Life (@omniharmonic)
**Consolidates:** research brief (01), product spec (02 v0.3), POS brief (04), adoption blueprint (05), identity layer (06). This PRD is the product source of truth for the build; docs 01–06 remain the rationale record.
**Companions:** B2 Technical Architecture · B3 Protocol & Schema Reference · B4 Implementation Plan

---

## 1. Product statement

A **multi-bioregion platform** for place-based identity, trust, funding and exchange. Each bioregion runs its own **pod** — a verifiable trust community with its own identity, branding, governance, trust policy, currency and app front end — on shared open protocols, so that trust and credentials travel between pods and no platform or state issues the identity.

Residents prove who they are to each other in person, vouch for one another, join groups, fund projects with trust-weighted votes, and trade in a local mutual-credit currency that is never sold for dollars. Boulder is the first pod; the platform must onboard a second bioregion with a customised front end **from day one**, not as a later phase.

**Working name:** "Bioregional Passport" for the platform; each pod chooses its own product name (e.g. "Boulder Commons"). Rename of the platform is an open decision (§13).

## 2. Goals and non-goals

**Goals (v1, six months)**
1. Boulder pod live: ≥ 300 trusted residents, ≥ 3 attestation events, one grants round, 25 enterprises accepting credit, re-spend ratio ≥ 60%.
2. A second bioregion pod provisioned from the same codebase with its own name, theme, place registry, trust policy and currency, without code changes — proven at week 12 with a synthetic "tenant zero," live with a real Front Range pod by week 24.
3. Trust plane on standards: ToIP DTG Core Credentials (WD02 profile), W3C VC 2.0, `did:webvh` / `did:peer`, Credo wallet, TRQP registry — so a third bioregion could be run by people we have never met.
4. Three external applications gate on Passport credentials at the door (Free School, one deliberation tool, the tool library) via the Verifier SDK.

**Non-goals (v1)**
- Fiat in the app in any form: no top-up, cards, Apple Wallet payment passes, node-run conversion.
- Government-ID import as a requirement (the wallet can *accept* one; no pod requires it by default).
- Zero-knowledge presentations (designed for, not shipped; disclosure path in v1).
- Encrypted messaging (use Signal/Matrix).
- Cross-bioregion currency exchange (nodes are provisioned under one Credit Commons trunk so it becomes possible; not enabled).
- Apple NFC Secure Element integration (closed to non-financial-institutions in the US).

## 3. Users and jobs

| Persona | Scope | First job-to-be-done |
|---|---|---|
| **Resident** | one or more pods | Get witnessed at an event; see who trusts them; pay a farm stand in credits |
| **Convener / Steward** (T3) | pod | Run attestation events; witness edges; onboard merchants; broker credit matches; mediate disputes |
| **Anchor (CTA)** (T4) | pod | Co-sign admissions; countersign the pod's DID log; hold governance |
| **Enterprise owner** | pod | Publish offers; accept credits at the counter; delegate receiving to staff |
| **Enterprise staff** | pod | Receive credits with their own key under an attenuated authority |
| **Group steward** | group inside a pod | Act for a co-op or working group (vote its allocation, sign for it) |
| **Grant participant** | pod | Propose; vote with trust-weighted voice |
| **Round steward** | pod | Open/close rounds; review sybil flags; publish tallies |
| **Circulation steward** | pod | Set limits; run balance circles; exports; kill-criteria monitoring |
| **Pod operator** | pod | Provision the pod; set theme, modules, trust policy, governance; manage anchors |
| **Platform operator** (Commons Operator) | platform | Provision pods; run shared infrastructure; publish the VTN registry; steward lexicons and vocabularies |
| **Third-party app developer** | any | Gate an app on Passport membership and authority via the Verifier SDK |

## 4. Product principles (binding)

1. Peer-attested, not state-issued. 2. You hold your credentials; no central "who trusts whom." 3. Open records, held trust. 4. One-stop shop, many doors — every module also stands alone and accepts the same credentials. 5. No tokens, no web3 vocabulary. 6. Recoverable. 7. Legible trust — every gate explains itself in one sentence. 8. **Every bioregion is sovereign** — its DID, governance, policy, currency, data and look are its own; the platform is plumbing. 9. **Credit is never sold.** 10. Consent is structural — no membership or delegation exists without the member's own signature.

## 5. Scope by module

### 5.1 Core (identity, trust, wallet)
- Identifiers at declared correlation scope: public `did:plc` (ATProto only), one directed pod persona per pod, pairwise per relationship.
- Wallet holds all seven DTG credential types; VC 2.0 `eddsa-jcs-2022`; accepts VC 1.1, SD-JWT VC, mdoc, AnonCreds presentations; issues none.
- In-person ceremony (VRC pair + VWC + VMC pair) fully offline, sync later.
- Tiers T0 Visitor → T1 Member → T2 Trusted → T3 Steward → T4 Anchor; permissions issued as authority credentials (VACs) by the pod's policy enforcement point; no service recomputes trust.
- Groups as nested trust communities with their own `did:webvh`; delegation (VDC) and attenuable authority (VAC).
- Multi-pod wallet: a person may be a member of several pods with the same or different personas — their choice.
- Recovery: 2-of-3 social recovery + encrypted backup; `did:plc` rotation keys for the public persona.

### 5.2 Grants
Quarterly rounds; membership-gated proposing (T2) and voting (T2); trust-weighted quadratic voting with per-round pseudonyms; verifiable tally; steward sybil review with logged adjustments; group voting via delegation chains; results as open records.

### 5.3 Circulation
Per-pod Credit Commons node; accounts on `credit:account` VAC; limits by tier VAC; two-leg QR payment with POS write-back (Square → Clover → Shopify → Toast); Merchant Mode (acceptance rules, ceilings, exposure dashboard, staff by attenuated `pay:receive`, offline allowance, receipts); steward console with brokerage queue; commitment records; tax exports (CSV/QBO, 1099-B totals, W-9 capture); consumer call to action "What can you offer?"; kill criteria.

### 5.4 Map / Discovery
Enterprises, events, groups, funded projects as open ATProto lexicon records with place IDs; per-pod AppView filtered by bioregion; Twin deep links and layer overlays by shared place ID; schema.org export.

### 5.5 Pod platform (new; the day-one multi-bioregion requirement)
- **Bioregion manifest** drives everything tenant-specific: name, DID, theme tokens, logo, modules enabled, copy overrides, map bounds and place registry, trust policy, currency parameters, service endpoints, governance URL, contact.
- **Custom front end per pod:** runtime theming and copy in the shared mobile app (pod picker + deep links), plus optional white-label builds (own store listing, icon, name) from the same code; per-pod web domains for Grants, Directory and Steward Console.
- **Provisioning:** `passport bioregion create <slug>` provisions a pod end-to-end (DID, database schema, ledger node, AppView index, mediator route, web domain, VTN registry entry, governance template, anchor invitations) in under one hour, no code change.
- **Federation:** pods register in a bioregional trust network (TRQP v2.0 registry); ledgers nest under a shared Credit Commons trunk; lexicons and vocabularies are shared and versioned.
- **Third-party modules:** the Verifier SDK and a module manifest let external apps (tool library, deliberation tools) appear in a pod's launcher and gate on its credentials.

## 6. Core flows (normative)

**F1 Onboard (T0).** Install → choose pod (or open a pod deep link) → app mints directed pod persona and creates/links `did:plc` → set recovery contacts → confirm watershed → Visitor: browse map, directory, events, open rounds; single call to action: "Find an attestation event."

**F2 Become a member (T1).** VIC from a member/convener or arrive without one → at the event: QR out-of-band → DID exchange → mutual VRC → convener issues VWC bound to the event → pod grants VMC → member acknowledges → PEP issues T1 VACs (`vrc:exchange`, `vec:issue`, `credit:account`, `round:comment`). Works offline; pod steps run at next sync.

**F3 Become trusted (T2).** Index recomputes on each witnessed edge; on crossing the threshold the PEP issues T2 VACs (`round:vote`, `round:propose`, `vic:issue`, `vec:issue:weighted`, `credit:limit:L2`, `group:create`); the app shows why and what would change it.

**F4 Vouch.** Contact → Vouch → scope (lives-here / worked-with / knows) → sign → VEC issued; revocable; evidence only.

**F5 Groups.** Create (T2): mint group `did:webvh`, governance template, invite CTAs → admit by VIC/VMC pair → delegate (VDC) a steward to act for the group → attenuate authority (VAC) to staff → leave by revoking own acknowledgement.

**F6 Grants round.** Open (pool, dates, eligibility) → propose → vote (pseudonym, VAC `round:vote`, group via VDC chain) → tally → steward review → publish.

**F7 Pay — two legs, one moment.** Merchant rings up → Merchant Mode proposes credit amount from rules → signed Payment Request QR → wallet signs Credit Commons transfer with a pairwise DID and presents membership pair + `credit:account` VAC → node confirms < 5 s → POS adapter records external tender → remaining dollars on the merchant's rails → one receipt. Offline: both sign, sync within allowance.

**F8 Earn.** Provide an offer listed in the directory; receive credits; never "add funds."

**F9 Provision a pod (operator).** Run the provisioning command with a manifest → verify DID and witnesses → invite anchors → publish governance and trust policy → set theme and modules → announce first attestation event.

**F10 Gate an external app (developer).** Install Verifier SDK → declare policy (accepted pod DIDs, required VMC + VAC scopes) → present request → verify → session.

## 7. Functional requirements

Numbered for traceability into B4.

**Identity & wallet**
- FR-ID-1 Mint and manage identifiers at declared scope; refuse pairwise reuse; revocable persona link to `did:plc`.
- FR-ID-2 Hold, verify and present all seven DTG types; VC 2.0 with `DataIntegrityProof`/`eddsa-jcs-2022`; accept 1.1/SD-JWT/mdoc/AnonCreds; issue none.
- FR-ID-3 Complete VMC/VDC edges only on explicit consent; issue VRC/VEC; request VWC; attenuate VAC with `maxDepth: 0` default.
- FR-ID-4 Offline ceremony end-to-end; sync with conflict-free replay.
- FR-ID-5 2-of-3 social recovery; encrypted backup; pod re-issues VMC to recovered identifier.
- FR-ID-6 Multi-pod membership in one wallet; per-pod persona choice.
- FR-ID-7 Keys in secure enclave/StrongBox; ML-DSA slot reserved.

**Trust**
- FR-TR-1 Per-pod trust index computes `score = D × (α·W + β·E) × R` over opted-in edge commitments; parameters from the pod's signed trust policy.
- FR-TR-2 Index emits tier recommendation + explanation; PEP issues/declines VACs (90-day validity); downgrades apply at expiry, never mid-round.
- FR-TR-3 Sybil controls: admission only with VWC from a T3+ convener at a physical event; spread requirement across events/conveners; anomaly flags to steward review, never auto-revoke.
- FR-TR-4 Disputes on any VEC/VWC; adjudication logged as a VSC.
- FR-TR-5 Optional IDVC requirement is a per-pod governance switch, off by default.

**Grants** — FR-GR-1 round lifecycle; FR-GR-2 QV with signed pseudonymous ballots and verifiable tally; FR-GR-3 group voting via VDC chain; FR-GR-4 steward review log; FR-GR-5 results as `project` records.

**Circulation** — FR-CI-1 account on `credit:account` VAC, limit from `credit:limit:Ln` VAC; FR-CI-2 Payment Request `org.bioregion.pay.request` and signed transfer; FR-CI-3 POS adapters (Square first) with > 90% auto-reconciliation; FR-CI-4 Merchant Mode incl. staff attenuation, offline allowance, receipts; FR-CI-5 steward console with brokerage queue, ceiling heat-map, matches log, dispute queue; FR-CI-6 commitment record per enterprise; FR-CI-7 exports and 1099-B totals, W-9 capture; FR-CI-8 kill-criteria dashboard.

**Map / records** — FR-MP-1 lexicon records with `bioregion` and place ID; FR-MP-2 per-pod AppView; FR-MP-3 Twin deep links; FR-MP-4 schema.org export.

**Pod platform**
- FR-PP-1 Bioregion manifest schema (B3 §7) validated at provision time; hot-reloadable for theme/copy.
- FR-PP-2 Provisioning command creates DID (portable, pre-rotation, ≥ 2 witnesses), DB schema, ledger node, AppView index, mediator route, web domains, registry entry, governance and trust-policy templates, anchor VICs — idempotent, < 1 hour.
- FR-PP-3 Shared mobile app: pod picker, deep-link join (`passport://join/<slug>`), runtime theme/copy/module toggles from manifest; white-label build profile from the same manifest.
- FR-PP-4 Per-pod web apps at `<slug>.<platform-domain>` or custom domain, themed from the manifest.
- FR-PP-5 Data isolation: per-pod Postgres schema, per-pod ledger, per-pod object-storage prefix; no cross-pod query path except the public registry and open records.
- FR-PP-6 Pod operator console: manifest editor, anchors, governance, trust policy, module toggles, health.
- FR-PP-7 VTN registry (TRQP v2.0) lists pods, anchors, accepted issuers; Verifier SDK resolves policy through it.
- FR-PP-8 Module manifest for third-party apps: name, icon, deep link, required credentials; appears in the pod launcher when the pod enables it.

**Verifier SDK** — FR-VS-1 `verifyDTG(presentation, policy)` covering proofs, digests, edge completion, VDC chains, VAC attenuation, predicate accept-lists, expiry/status; FR-VS-2 JS/TS first, then Python; FR-VS-3 session issuance helpers; FR-VS-4 conformance test vectors published.

## 8. Non-functional requirements

| Area | Requirement |
|---|---|
| Privacy | VRC/VEC/VPC/VDC never leave wallets unless presented; membership never on the firehose; pod governance publishes disclosure policy; index holds salted commitments over directed identifiers; short expiry preferred over status lookups; nonce in every grant |
| Security | Keys in hardware keystore; signed trust policy and manifest; DID log witnesses; audit log for PEP issuance; threat model reviewed before Boulder launch |
| Availability | Pod services 99.5% monthly; ceremony and payment offline-tolerant; AppView read path cached |
| Performance | QR-to-confirmation < 5 s p50; VAC issuance < 60 s online; 500-edge wallet verifies a presentation < 2 s on a 2021 mid-range Android |
| Portability | Any credential exportable; pod data exportable (records, ledger, policy) for self-hosting; `did:webvh` portable |
| Legibility | Every gate explains itself in one sentence; explanation payload for every tier decision |
| Accessibility | WCAG AA; low-end Android; offline-first |
| Compliance | No fiat custody; barter-exchange posture; 1099-B/W-9 built in; Colorado counsel opinion before Circulation launch; each pod attaches its own counsel note |
| Sovereignty | A pod can leave the platform with its DID, data, ledger and members intact |

## 9. Success metrics

**Platform:** second pod provisioned from manifest with zero code change (week 12 synthetic; week 24 real); pod provisioning < 1 hour; ≥ 3 external apps on the Verifier SDK.
**Trust:** ≥ 300 trusted residents; ≥ 3 attestation events; median witnessed edges ≥ 3 across ≥ 2 events; median hops-to-seed ≤ 2; zero membership leaks; zero unrecoverable identity losses.
**Grants:** ≥ 20 proposals, ≥ 150 voters, sybil adjustments < 5% of matching.
**Circulation:** re-spend ratio ≥ 60% at 60 days by G4 (primary); no merchant > 80% ceiling two months without contact; ≥ 3 live offers per merchant purchase category; QR-to-confirmation < 5 s; > 90% auto-reconciliation; disputes < 7 days; ≥ 25 enterprises; ≥ 1,000 tx/quarter.
**Kill criteria (Circulation, two consecutive months):** re-spend < 35%; > ⅓ merchants above 80% ceiling; unmet demand outpacing matches; counsel flags transmitter status.

## 10. Release plan

| Release | Weeks | Scope |
|---|---|---|
| R0 Foundations | 1–4 | Monorepo, `credential-core`, tenant manifest, pod provisioning skeleton, Boulder pod DID |
| R1 Trust core | 5–8 | Offline ceremony on two phones; PEP issuing VACs; Verifier SDK; Free School at the door |
| R2 Open records + map | 6–10 | Lexicons, PDS, AppView, Twin links; pod theming live |
| R3 Tenant zero | 11–12 | Synthetic second pod provisioned end-to-end; white-label build produced; gate for multi-tenancy |
| R4 Grants v1 | 9–14 | Round service; first Boulder round (Q1 2027) |
| R5 Circulation G0–G3 | 8–18 | Counsel, steward, node, Merchant Mode v0, Square write-back, 25 enterprises |
| R6 Second real pod + G4 | 19–24 | Front Range pod live; Clover/Shopify; anchor institution; VTN registry public |
| R7 Harden | 18–24 | Status lists, OID4VP, proof sets, federation tests, VTI evaluation |

## 11. Risks (product level)

Spend-side collapse; regulatory ambush; spec churn (DTG WD02); wallet framework gaps (Credo VC 2.0 DI, DIDComm v2); `did:plc` governance; seed-set capture; name collision; second-pod demand (is there a Front Range pod ready by week 19?); operator capacity (one steward per pod is non-negotiable). Mitigations in docs 05 §1–2 and 06 §11; tracked in B4 §9.

## 12. Dependencies and external parties

ToIP DTGWG (spec), OpenVTC labs (reference impl), OWF Credo/Bifold, Credit Commons Group (node), Grassroots Economics and Mutual Credit Services (limits), Colorado counsel, Square/Clover/Shopify developer programs, Bioregional Twin (place IDs), Free School and tool library (first verifiers), IIW #43 (3–5 Nov 2026) for the pod pilot proposal.

## 13. Open decisions (owner: Benjamin)

1. Platform name (and the policy that pods name themselves).
2. Tier thresholds and Boulder seed set for the governance draft.
3. Unit of account and starter limits per pod (default proposed: USD-parity units, L1 = one week of groceries).
4. Which VTN: own Front Range network via TRQP (recommended), FPN interop as goal.
5. Whether pod VTA/PEP moves to the Rust VTI stack after v1.
6. POS adapter order after the merchant census.
7. Acceptance/ceiling defaults by ring.
8. Cashback issuance pending counsel.
9. IDVC switch governance clause.
10. Mediator hosting: pod-run vs. trust service provider.
11. White-label store publishing policy (who owns the Apple/Google developer accounts for a pod's build).
