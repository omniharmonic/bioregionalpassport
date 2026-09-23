# Bioregional Passport — Protocol & Schema Reference

**Build set B3 of 4 · v1.0 draft · 22 September 2026**
**Author:** Benjamin Life (@omniharmonic)
**Purpose:** the wire-level contracts every component and every third-party implementer builds against. Normative where marked. Versioned independently of the code; breaking changes bump the major and get a new `@context` / lexicon version.
**Companions:** B1 PRD · B2 Technical Architecture · B4 Implementation Plan

---

## 1. Identifier profile (normative)

| Identifier | Method | Scope | Rules |
|---|---|---|---|
| Pod, group, platform services | `did:webvh` v1.0 | public | `portable: true` at inception; pre-rotation on; ≥ 2 DID-log witnesses (platform VTA + one anchor); hosted at `https://<platform-domain>/dids/<slug>/did.jsonl` and mirrored at the pod domain |
| Pod persona (per pod, per person) | `did:peer:4` | directed | Lives as long as the membership; rotation via DID rotation protocol; declared in every credential as `bioregion:scope: "directed"` |
| Relationship | `did:peer:2` or `4` | pairwise | One counterparty ever; reuse falsifies the declaration and is flagged |
| Per-round voting | derived `did:key` | pairwise | Derived from pod persona + roundId; discarded after tally |
| ATProto public persona | `did:plc` | public | Signs the repo only; linked by VPC + `org.bioregion.identity.link`; never signs Trust-plane credentials |

Scope declaration: until the DTG spec names the property, every credential we issue carries `credentialSubject.bioregionScope` (issuer's declared scope) under our context; verifiers ignore it for correctness and log it for privacy audits.

## 2. Credential profile (normative)

Base: W3C VC 2.0; `@context` = `["https://www.w3.org/ns/credentials/v2", "https://firstperson.network/credentials/dtg/v1", "https://bioregion.org/credentials/v1"]`; `proof.type = DataIntegrityProof`, `cryptosuite = eddsa-jcs-2022`; digests per DTG Digest Encoding (JCS → SHA-256 → multihash → base58btc `z…`). Verifiers accept VC 1.1 with the DI v2 context. Long-lived credentials carry `BitstringStatusListEntry`; VACs and VWCs rely on expiry.

| Type | Issuer → subject | Required claims (ours) | validUntil |
|---|---|---|---|
| `MembershipCredential` grant | pod/group DID → member | `bioregion` (slug), `placeIds[]` (watershed), `nonce` (≥ 128 bits), `governance` (URL) | ≤ 90 d |
| `MembershipCredential` ack | member → pod/group | `digestMultibase` of grant | ≤ 90 d |
| `InvitationCredential` | member/pod → prospect | `bioregion`, `event` (optional ref) | ≤ 30 d |
| `RelationshipCredential` | person ↔ person | `bioregion`, `placeId`, `formedAt` | none |
| `StatementCredential` `dtg:endorses` | person → person | `object.value.scope ∈ {lives-here, worked-with, knows}` | none (age-decayed) |
| `StatementCredential` `dtg:witnessed` | convener/pod VTA → edge | `object.digestMultibase` (edge credential), `taskContext` (event doc id), `taskDigestMultibase`, `evidence ∈ {same-event, liveness}` | 1 y |
| `DelegationCredential` grant/accept | group → steward | `delegation.scope[]` from vocabulary, `maxDepth` (default 0), `accepts` on acceptance | required |
| `AuthorityCredential` | pod PEP / owner → member/staff | `authority.scope` (pod or enterprise DID), `authority.actions[]`, `authority.parent` on attenuation, `tier` (informational) | 90 d (pod), ≤ 30 d (attenuated) |
| `PersonaCredential` | person (directed) → `did:plc` | — | none |
| `StatementCredential` `bioregion:adjudicated` | steward → subject | `object.digestMultibase` (disputed credential), `outcome` | 1 y |

Pod-defined predicates live at `https://bioregion.org/vocab/v1#` and never change meaning once published.

## 3. Authority scope vocabulary (normative, additive)

Opaque strings, exact match. Published at `https://bioregion.org/authority/v1`.

| Term | Meaning | Default tier |
|---|---|---|
| `event:attend` | may register for attestation events | T1 |
| `vrc:exchange` | may form relationships inside the pod | T1 |
| `vec:issue` / `vec:issue:weighted` | may endorse (unweighted / index-weighted) | T1 / T2 |
| `round:comment` / `round:vote` / `round:propose` | grants participation | T1 / T2 / T2 |
| `credit:account` | may open a ledger account | T1 |
| `credit:limit:L1` … `L3` | credit line band | T1 / T2 / T3 |
| `vic:issue` / `vic:issue:unlimited` | may invite (rate-limited / unlimited) | T2 / T4 |
| `group:create` | may mint a group VTC | T2 |
| `pay:receive` | may receive credits at the named enterprise scope | owner; attenuated to staff |
| `event:convene` / `vwc:issue` | may convene events and witness edges | T3 |
| `pep:review` / `registry:propose` | steward review; propose registry changes | T3 |
| `vmc:grant` / `did:witness` | co-sign admissions; countersign the pod DID log | T4 |

## 4. Trust policy document (normative)

Signed by the pod DID; referenced from the manifest; versioned.

```json
{
  "type": "org.bioregion.trust.policy",
  "pod": "did:webvh:…:boulder",
  "version": 1,
  "weights": { "alpha": 1.0, "beta": 0.5, "hopDecay": 0.6, "endorsementHalfLifeDays": 365,
               "scopeWeights": { "lives-here": 1.0, "worked-with": 0.8, "knows": 0.5 } },
  "seedSet": ["did:peer:4:…", "…"],
  "seedRotationMonths": 12,
  "tiers": {
    "T1": { "requires": ["vmcPairComplete", "witnessedEdges>=1"] },
    "T2": { "requires": ["witnessedEdges>=3", "distinctEvents>=2", "weightedEndorsements>=2", "seedHops<=3", "spread>=0.5"] },
    "T3": { "requires": ["electedByGovernance", "T2for>=180d"] },
    "T4": { "requires": ["namedInGovernance"] }
  },
  "vacValidityDays": 90, "grantValidityDays": 90, "vicRatePerMonth": { "T2": 3 },
  "idvcRequired": false, "downgradeAtExpiryOnly": true,
  "anomaly": { "endorsementVelocityPerDay": 5, "sharedWitnessOnlyFlag": true }
}
```

## 5. Ceremony and exchange protocol (normative for v1; migrates to DTG Trust Task protocols when published)

Transport: QR out-of-band → DIDComm v1 connection (v2 when available) → messages below as DIDComm attachments; pod ↔ member via the pod VTA endpoint from the manifest; offline messages queued at the mediator.

| Message | From → to | Body |
|---|---|---|
| `org.bioregion.oob.invite` | either | pairwise DID, challenge, pod slug, event id (optional) |
| `org.bioregion.vrc.offer` / `.accept` | peer ↔ peer | VRC half; optional VEC |
| `org.bioregion.witness.request` / `.result` | member → convener | edge digest, event taskContext → VWC |
| `org.bioregion.event.attestation` | pod → convener | the Trust Task document for the event: `{id, pod, startsAt, endsAt, conveners[], location(placeId)}`; its digest is `taskDigestMultibase` in VWCs |
| `org.bioregion.membership.apply` / `.grant` / `.ack` | member ↔ pod VTA | VIC (optional) + VWC + proof of control → VMC grant → member ack |
| `org.bioregion.authority.issue` / `.revoke` | pod PEP → member | VAC(s) + explanation payload |
| `org.bioregion.index.commit` | member → index | salted commitment(s), scope tags, VWC refs (opt-in) |
| `org.bioregion.recovery.share` / `.request` | member ↔ peers | encrypted share; quorum request |

Offline replay: messages carry `createdAt` and a per-sender sequence; the receiver applies in order; conflicting duplicate edge halves resolve to the earliest signed.

## 6. Payment protocol (normative; from doc 04 §4.2)

`org.bioregion.pay.request` (merchant → customer, in QR): `merchant` (enterprise DID), `pod`, `node`, `amount{unit,value}`, `totalSale{unit,value}`, `invoice`, `expires`, `acceptance{maxShare, requires:["MembershipCredential:pod","AuthorityCredential:credit:account"]}`, `sig`.
`org.bioregion.pay.authorization` (customer → node via gateway): signed Credit Commons transfer from a pairwise DID + presentation (membership pair + `credit:account` and `credit:limit:Ln` VACs; receiver presents `pay:receive` VAC chain).
`org.bioregion.pay.receipt` (node → both): transaction id, amounts, timestamps, POS write-back status.

## 7. Bioregion manifest schema (normative)

```json
{
  "$schema": "https://bioregion.org/schemas/manifest/v1",
  "identity": { "slug": "boulder", "name": "Boulder Commons", "did": "did:webvh:…:boulder",
                "handleDomain": "boulder.bioregion.org", "contact": "stewards@…" },
  "theme": { "tokens": { "primary": "#1F5F4A", "accent": "#E4B04A", "bg": "#FBF8F2", "fg": "#17201C" },
             "font": { "display": "Fraunces", "body": "Inter" }, "logo": "…/logo.svg",
             "icon": "…/icon.png", "splash": "…/splash.png", "tone": "warm" },
  "copy": { "en": { "cta.findEvent": "Find a gathering", "tier.T2.name": "Trusted neighbor" } },
  "place": { "bioregionPolygon": "twin:bioregion/south-platte-headwaters",
             "watershedSource": { "type": "twin", "endpoint": "https://mcp.bioregionaltwin.org/mcp" },
             "bounds": [[-105.7,39.9],[-105.1,40.2]], "defaultZoom": 11 },
  "modules": { "map": true, "grants": true, "circulation": true, "merchant": true,
               "thirdParty": [ { "id": "free-school", "name": "Free School", "deepLink": "freeschool://", "requires": ["MembershipCredential:pod"] } ] },
  "trustPolicy": "https://boulder.bioregion.org/policy/trust-v1.json",
  "currency": { "unit": "credit", "parity": "USD (informal)", "limits": { "L1": 100, "L2": 400, "L3": 1000 },
                "defaultAcceptance": { "services": 0.75, "suppliers": 0.35, "retail": 0.2 },
                "offlineAllowancePerDay": 50, "node": "https://node.boulder.bioregion.org" },
  "services": { "vta": "https://vta.boulder.bioregion.org", "index": "…", "round": "…", "appview": "…",
                "mediator": "https://mediator.bioregion.org", "registry": "https://registry.bioregion.org/trqp" },
  "governance": { "url": "https://boulder.bioregion.org/governance", "disclosure": "Member identifiers are never disclosed beyond the pod VTA.",
                  "anchors": ["did:peer:4:…", "…"], "disputes": "disputes@…" },
  "build": { "iosBundleId": "org.bioregion.boulder", "androidPackage": "org.bioregion.boulder", "scheme": "bouldercommons" },
  "proof": { "type": "DataIntegrityProof", "cryptosuite": "eddsa-jcs-2022", "verificationMethod": "did:webvh:…:boulder#key-1", "proofValue": "z…" }
}
```

## 8. ATProto lexicons (`org.bioregion.*`, shared across pods)

Every record has `bioregion` (slug) and, where spatial, `placeId`.

| Lexicon | Key fields |
|---|---|
| `org.bioregion.place` | `placeId` (HUC-12 or bioregion ref), `name`, `geometryRef`, `twinRef` |
| `org.bioregion.enterprise` | `name`, `categories[]`, `acceptsLocalCredit`, `acceptanceShare`, `stewardDids[]`, `placeId`, `did` (enterprise VTC) |
| `org.bioregion.offer` / `.need` | Valueflows: `resourceSpec`, `quantity{unit,value}`, `availability`, `enterprise` |
| `org.bioregion.event` | reuse of the events lexicon from the events-adapter work + `attestation: bool`, `conveners[]` |
| `org.bioregion.group` | public face only: `name`, `description`, `did`, `contact` — membership never here |
| `org.bioregion.project` | proposal + outcome: `round`, `budget`, `lead`, `placeId`, `funded`, `tally` |
| `org.bioregion.identity.link` | `podPersona` (directed DID), `vpcDigest`, `revocable: true` |
| `org.bioregion.pod` | public pod card: `slug`, `name`, `did`, `manifestUrl`, `registryEntry` |

## 9. Service APIs (summary)

All pod services: `X-Pod` header or host-derived tenant; JSON; errors `{code, message, hint}`.

| Service | Endpoint | Purpose |
|---|---|---|
| VTA/PEP | `POST /membership/apply`, `/membership/ack`, `GET /governance`, `POST /authority/refresh`, `GET /status/{list}` | ceremony back half, VAC refresh, status lists |
| Index | `POST /commit`, `GET /me/explanation`, `GET /steward/flags` | commitments; explanations; anomaly review |
| Round | `POST /rounds`, `POST /rounds/{id}/proposals`, `POST /rounds/{id}/ballots`, `POST /rounds/{id}/adjustments`, `GET /rounds/{id}/tally` | grants |
| Ledger gateway | `POST /pay/authorize`, `GET /accounts/me/statement`, `POST /accounts/open`, `GET /steward/exposure`, `POST /disputes` | circulation |
| POS adapter | `POST /square/connect`, `POST /tender/record`, `GET /reconcile/pending` | write-back |
| AppView | `GET /map`, `/directory`, `/search`, `/schema-org/{type}` | open records |
| Control plane | `POST /pods`, `PUT /pods/{slug}/manifest`, `POST /pods/{slug}/verify`, `GET /pods/{slug}/export` | provisioning |
| Registry (TRQP v2.0) | `GET /authorization?entity=&authority=&context=`, `GET /recognition` | verifier policy |

## 10. Verifier SDK contract

```ts
verifyDTG(presentation, {
  acceptedPods: ['did:webvh:…:boulder'] | 'registry',
  requireMembership: true,
  requireAuthority: ['round:vote'],
  allowDelegation: true,            // resolve VDC chain to a group DID
  maxClockSkewSec: 300,
  statusCheck: 'ifPresent'
}) → { ok, subject, pod, tier, authorities[], delegatedFor?, explanation[] }
```
Conformance vectors (`packages/verifier-sdk/vectors/`): valid pair; grant without ack; ack digest mismatch; expired VAC; broadened attenuation; VDC chain exceeding depth; unknown predicate; pod mismatch.

## 11. Versioning

`@context` and lexicon versions are immutable; additive changes only. Manifest schema semver; app refuses manifests with a higher major. Trust policy `version` increments; VACs record the policy version they were issued under. DTG profile pin recorded in `dtg-compat.md`; re-pinned per tagged working draft.
