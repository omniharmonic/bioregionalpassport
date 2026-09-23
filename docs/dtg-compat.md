# DTG compatibility log

Tracks Bioregional Passport's pin to the Trust over IP Foundation's DTG Core Credentials specification, what `@passport/credential-core` actually implements against B3 §2's normative credential profile, and what to re-check the next time the pin moves. Required by B3 §11 ("DTG profile pin recorded in `dtg-compat.md`; re-pinned per tagged working draft").

## Pin statement

- **Pinned draft:** DTG Core Credentials, working draft **WD02**, per `docs/build-set/11-passport-technical-architecture.md` and `docs/build-set/13-passport-implementation-plan.md` ("pin, don't chase — DTG WD02 and Credo 0.6 are pinned; upgrades are deliberate, logged, and tested against conformance vectors").
- **Credential envelope:** W3C Verifiable Credentials 2.0, `@context` = `["https://www.w3.org/ns/credentials/v2", "https://firstperson.network/credentials/dtg/v1", "https://bioregion.org/credentials/v1"]` in that order (`CONTEXTS` in `packages/credential-core/src/credentials.ts`). Verifiers accept VC 1.1 with the DI v2 context (not yet exercised by a conformance vector — see deviations below).
- **Proof suite:** `proof.type = "DataIntegrityProof"`, `cryptosuite = "eddsa-jcs-2022"`, implemented in `packages/credential-core/src/proof.ts` (see below).
- **Digest encoding:** JCS → SHA-256 → multihash (`0x12` sha2-256, `0x20` 32-byte length prefix) → base58btc, prefixed `z` (`digestMultibase` in `packages/credential-core/src/encoding.ts`). Known-answer test: `digestMultibase({"a":1}) === "zQmNRwNKPCo7tufiPf7zBwJhKdswzFLyWHE5am6tAXP7EbB"`, cross-checked independently against `node:crypto` sha256 + base58btc (`.superpowers/sdd/mvp/task-1-report.md`).
- **Re-pin process (B3 §11):** the `@context` and lexicon versions are immutable — a re-pin is additive, never a silent redefinition. A re-pin is logged in this file with a vector diff against `packages/verifier-sdk/vectors/`, and the app refuses a manifest whose schema major is higher than it understands.

## B3 §2 credential profile vs. what `@passport/credential-core` implements

| B3 §2 type | Builder(s) in `packages/credential-core/src/credentials.ts` | Required claims implemented | Notes |
|---|---|---|---|
| `MembershipCredential` grant | `buildMembershipGrant` | `bioregion`, `placeIds[]`, `nonce` (≥128 bits, `randomNonce`), `governance` | `validUntil` ceiling enforced ≤ 90 d (throws otherwise) |
| `MembershipCredential` ack | `buildMembershipAck` | `digestMultibase` of the grant | pair completeness checked by `isMembershipPairComplete(grant, ack, now?)`; ceiling ≤ 90 d |
| `InvitationCredential` | `buildInvitation` | `bioregion`, optional `event` | ceiling ≤ 30 d |
| `RelationshipCredential` | `buildRelationship` | `bioregion`, optional `placeId`, `formedAt` | no expiry, per B3 |
| `StatementCredential` `dtg:endorses` | `buildEndorsement` | `object.value.scope ∈ {lives-here, worked-with, knows}` | no expiry (age-decayed by the trust-index scorer, not the credential itself) |
| `StatementCredential` `dtg:witnessed` | `buildWitness` | `object.digestMultibase`, `taskContext`, `taskDigestMultibase`, `evidence ∈ {same-event, liveness}` | ceiling ≤ 365 d; `credentialSubject.id = "urn:digest:<edgeDigest>"` when no `subject` is given |
| `DelegationCredential` grant | `buildDelegation` | `delegation.scope[]`, `maxDepth` (default 0) | required `validUntil` |
| `DelegationCredential` accept | `buildDelegationAcceptance` | `delegation.accepts = digestMultibase(grant)` | added in the Task 1 review round (ADR-029) — not in the plan's original §4.1 draft, needed so acceptance is the delegate's own signature, not implied by the grant |
| `AuthorityCredential` | `buildAuthority`, `attenuate` | `authority.scope`, `authority.actions[]`, `authority.parent` on attenuation, `tier` (informational) | root ≤ 90 d, attenuated ≤ 30 d; `checkAuthorityChain` independently re-derives the attenuation rules for verifiers (ADR-029) |
| `PersonaCredential` | `buildPersonaLink` | links a `did:key` persona to a public DID | MVP has no `did:plc` yet (ADR-021), so this links a persona to whatever public identifier exists; re-check when `did:plc` lands |
| `StatementCredential` `bioregion:adjudicated` | `buildAdjudication` | `object.digestMultibase` (disputed credential), `outcome` | ceiling ≤ 365 d |

`VerifiablePresentation` (`createPresentation`) and its `proof` (`proofPurpose: "authentication"`, `challenge`/`domain` binding) are implemented per B3 §10's verifier contract, consumed by `@passport/verifier-sdk`'s `verifyDTG`.

## `eddsa-jcs-2022` implementation note

Implemented in `packages/credential-core/src/proof.ts` per the W3C Data Integrity EdDSA Cryptosuites v1 hashing algorithm:

```
hashData = sha256(JCS(proofConfig)) ‖ sha256(JCS(document-without-proof))
```

where `proofConfig` is the proof object without `proofValue`, carrying the document's `@context` when the document has one (`hashData` in `proof.ts`). The signature is Ed25519 over `hashData`, strict (non-ZIP215) verification; `proofValue = "z" + base58btc(signature)`. `verifyDocument` additionally requires, whatever the proof purpose: a document with an `issuer` must be signed by that issuer using `proofPurpose: "assertionMethod"`; a document with a `holder` (a presentation) must be signed by that holder using `proofPurpose: "authentication"`; the verification method must be listed under the resolved DID document's matching purpose array and controlled by the resolved DID.

**Known gap:** there is no official W3C `eddsa-jcs-2022` test vector available offline in this build, so the implementation has been checked against the specification's described algorithm and against our own known-answer digest, but interop with another independent implementation has not been proven. Adding the published W3C test vector to `packages/verifier-sdk/vectors/` is open work.

## Deviations from the build set / to re-check on re-pin

- **`bioregionScope` claim** (`credentialSubject.bioregionScope ∈ {"public","directed","pairwise"}`) is our own extension, carried on every credential we issue, standing in for the correlation-scope information `did:peer`/`did:plc` would otherwise encode structurally (ADR-021). B3 §1 itself notes this is provisional: "until the DTG spec names the property, every credential we issue carries `credentialSubject.bioregionScope`… verifiers ignore it for correctness." **Re-check:** if a future DTG draft names an equivalent property, migrate `bioregionScope` to it and keep the old key as a deprecated alias for one release.
- **`did:key` personas** stand in for `did:peer:4` for MVP (ADR-021). The resolver interface (`DidResolver.resolve(did) → DidDocument`) is method-agnostic, so `did:peer:4` support is additive, but any DTG semantics specific to `did:peer`'s rotation protocol are not yet implemented. **Re-check:** confirm `did:peer:4`'s rotation events don't need a new credential claim once implemented.
- **VWCs are intended to be issued by the pod VTA on behalf of the convener, carrying `witnessedBy`.** B3 §2 lists the issuer of `StatementCredential dtg:witnessed` as "convener/pod VTA" (B3 §2's table entry). The plan's design (Task 8, `services/pod-vta`, not yet implemented as of this writing) is for the pod VTA to issue the credential with its own signing key — so the credential's `issuer` is the pod DID, not the human convener's persona — and to record which convener requested the witnessing separately. `packages/credential-core`'s `buildWitness(p)` today signs with whatever `issuer` key is passed and has no dedicated `witnessedBy` claim; it is up to the pod-vta caller to either pass the convener's DID as `issuer` directly, or extend the credential subject with a `witnessedBy` claim before signing. **Re-check when Task 8 lands:** confirm which shape pod-vta actually used, and if DTG formalizes a co-signer/on-behalf-of claim, migrate to it.
- **Delegation acceptance credential** (ADR-029) is a Passport-specific addition to close a consent gap the plan's first draft had — B3 §2 mentions "accepts" as a field on the delegation credential ("required" in the "validUntil" column note) but the reference schema does not spell out that acceptance must itself be a separately signed credential. **Re-check:** if a future DTG draft standardizes delegation acceptance, confirm our `delegation.accepts = digestMultibase(grant)` shape matches or migrate.
- **VC 1.1 acceptance** is asserted in B3 §2 ("Verifiers accept VC 1.1 with the DI v2 context") but is not yet exercised by a `packages/verifier-sdk/vectors/` conformance vector. **Re-check:** add a VC 1.1 vector before claiming full B3 §2 conformance.
- **Status lists** (`BitstringStatusListEntry`) are implemented in the verifier SDK (`packages/verifier-sdk/src/status.ts`) but every pod currently publishes an all-zero list except for explicit revocations recorded via `vac_issuance_log.revoked_at` — no VAC or VWC issuer has run long enough for the decayed/expiry-based B3 model to be exercised at scale.
