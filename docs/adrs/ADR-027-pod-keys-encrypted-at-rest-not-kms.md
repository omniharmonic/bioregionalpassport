# ADR-027 — Pod signing keys encrypted at rest with an application key instead of KMS

**Status:** accepted · MVP scope

## Context

The build set's tenancy model (B2 §2.2) calls for per-pod KMS keys, with the PEP signing as the pod DID's `assertionMethod` key held in a KMS, so that no pod's signing material is ever readable outside a hardware- or cloud-HSM-backed boundary, and so a compromised database alone cannot forge a pod's credentials. Provisioning per-pod KMS keys (and the IAM to reach them) is infrastructure the MVP's single Neon/Vercel deployment does not have wired up yet.

## Decision

For MVP, each pod's Ed25519 signing key is generated once, encrypted at rest with AES-256-GCM under a single application-wide `POD_KEY_ENCRYPTION_KEY` (64 hex characters, 32 bytes), and stored in `platform.pod_keys` (`encryptPrivateKey`/`decryptPrivateKey`, `services/control-plane`). The key is decrypted in-process only when a pod needs to sign (provisioning, policy signing, VAC issuance) and is never written to logs or returned from any API. A KMS-backed per-pod key is the named follow-up.

## Consequences

Every pod's signing key shares one blast radius: whoever holds `POD_KEY_ENCRYPTION_KEY` (an operator environment variable) can decrypt every pod's key, and losing that single key means every pod's signing material is exposed at once — the opposite of the per-pod containment the build set's KMS design intends. `rotate-pod-key` (`docs/runbooks/rotate-pod-key.md`) is manual in MVP for the same reason: there is no KMS rotation API to call. Migrating to per-pod KMS keys later is a `pod_keys` row-by-row re-encryption (decrypt under the application key, re-encrypt under a new per-pod KMS key), not a schema or API change — `loadPodSigner`'s call sites do not need to know where the key came from.
