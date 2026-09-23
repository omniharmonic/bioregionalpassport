# ADR-025 — Wallet is a browser PWA instead of the Expo mobile app

**Status:** accepted · MVP scope

## Context

The build set (B2 §4.1) designs the Passport wallet as a shared Expo/React Native app on Credo, with a hardware-backed keystore for private key storage. A native mobile app needs app-store review, device provisioning, and a build/release pipeline the MVP does not have time to run before proving that the ceremony, credential storage and presentation flow work at all. The MVP's single deployable is already a Next.js app (ADR-026); a browser wallet reuses that deployment and lets anyone with a phone browser join a pod without installing anything.

## Decision

For MVP, the wallet is a browser progressive web app inside `apps/web` at `/wallet`, storing keys with `@noble` primitives in IndexedDB rather than a hardware keystore. `@passport/credential-core` — the same package that will back the Expo app — is the engine for both, so none of the DID, signing, credential or ceremony logic is wallet-specific. The Expo app and hardware-backed key storage are named follow-ups, not a different design.

## Consequences

Keys held in IndexedDB are only as safe as the browser profile they live in: no secure-enclave protection, no biometric gate beyond whatever the OS/browser itself offers, and a cleared browser profile is a lost wallet unless the holder made a backup (`createBackup`/`splitSecret` in `packages/credential-core`). The recovery flows (passphrase backup, 2-of-3 Shamir shares) exist specifically to make that loss survivable without a hardware keystore. Because `packages/credential-core` and `packages/pod-client` are UI-agnostic, moving to the Expo app later is a new front end consuming the same engine, not a protocol or credential-shape change; the ceremony's QR/relay transport (ADR-022) already assumes a phone-camera scan, which a native app performs the same way.
