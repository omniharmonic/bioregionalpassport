# Runbook: rotate a pod's signing key

**This procedure is manual in MVP (ADR-027).** There is no `passport` CLI command, console button, or API route for key rotation yet — per-pod KMS-backed rotation is a named follow-up. Treat rotation as an incident response to a suspected key compromise, not routine hygiene, until a graceful multi-key rollover exists (see "Known limitation" below).

## Background

Each pod's Ed25519 signing key lives in `platform.pod_keys` (`slug`, `kid`, `public_key_multibase`, `encrypted_private_key`, `created_at`), encrypted at rest with `POD_KEY_ENCRYPTION_KEY` (AES-256-GCM; `services/control-plane/src/keys.ts`). `platform.pod_keys` can hold more than one row per pod — `loadPodSigner` (and everything that signs on the pod's behalf: `provisionPod`, VAC issuance, event witnessing) always uses the **most recently created** row for that slug. The pod's DID document (`GET /dids/<slug>/did.json`, `didDocumentFor` in `services/control-plane/src/pods.ts`) is derived live from that same "most recent" row — it is **not** stored separately, and it lists only that one key.

### Known limitation

Because the DID document lists only the current key, inserting a new key row immediately removes the previous key's verification method from what resolvers see. Any credential the pod signed with the old key — including the pod's own manifest and trust policy, and every VAC/VWC/membership credential it issued that hasn't expired — becomes **unverifiable the instant the new key is inserted**, not at that credential's natural expiry. This is a hard cutover, not a graceful rollover. Plan rotations accordingly: expect to re-sign the manifest and the current trust policy right away (step 4 below), and expect active members' presentations built from now-unverifiable VACs to fail `verifyDTG` until they refresh (`POST /authority/refresh` once `services/pod-vta` is live) or re-run the ceremony.

## When to rotate

- Suspected compromise of `POD_KEY_ENCRYPTION_KEY` or of the database holding `platform.pod_keys`.
- Suspected compromise of a specific pod's decrypted key (e.g. it was logged or pasted somewhere).
- Not for routine hygiene in MVP — the cutover cost above makes that not worth it until graceful rollover exists.

## Procedure

All of the functions below are exported from `@passport/credential-core` and `@passport/control-plane`; nothing here requires modifying package source. Run this as a one-off Node script against the target database (same shape as `scripts/tenant-zero.mjs`, but against the real `DATABASE_URL`, not PGlite), with `DATABASE_URL` and `POD_KEY_ENCRYPTION_KEY` set in the environment.

1. **Generate a new key pair and bind it to the pod's `did:web`:**
   ```js
   import { generateKeyPair, keyPairForDid, signDocument } from '@passport/credential-core';
   import { encryptPrivateKey, podDid } from '@passport/control-plane';
   import { createDb } from '@passport/db';

   const db = createDb(process.env.DATABASE_URL);
   const slug = 'boulder';
   const did = podDid(process.env.PLATFORM_DOMAIN, slug);

   const fresh = generateKeyPair();                 // random Ed25519 key pair
   const nextFragment = 'key-2';                     // bump past the pod's current fragment
   const keyPair = keyPairForDid(did, fresh.privateKey, nextFragment); // binds it to did:web:…:slug#key-2
   ```
2. **Encrypt the new private key under the same `POD_KEY_ENCRYPTION_KEY`, with the same additional-authenticated-data convention `provisionPod` uses (`<slug>|<kid>`):**
   ```js
   const encrypted = await encryptPrivateKey(fresh.privateKey, process.env.POD_KEY_ENCRYPTION_KEY, `${slug}|${keyPair.kid}`);
   ```
3. **Insert the new row.** This is the cutover moment — from here on, `loadPodSigner` and the published DID document both use this key exclusively:
   ```js
   await db.query(
     'insert into platform.pod_keys (slug, kid, public_key_multibase, encrypted_private_key) values ($1, $2, $3, $4)',
     [slug, keyPair.kid, keyPair.publicKeyMultibase, encrypted],
   );
   ```
   Do not delete the old row — keep it as an audit record of what signed what, before the rotation.
4. **Re-sign the manifest and the current trust policy immediately**, since `provisionPod`'s idempotency check (manifest content hash) does not detect a key change on its own — a plain re-run of `bioregion create` with an unchanged manifest file reports `manifest: unchanged` and leaves the old-key-signed manifest in place. To force a re-sign, either:
   - bump something trivial in the manifest (a comment field, a copy string) so its content hash changes, then run `pnpm passport bioregion create --manifest <the edited file>`; or
   - directly re-sign in the same script: load the stored manifest and the latest `policy_versions` row, re-sign each with `signDocument(unsigned, keyPair, { created: new Date().toISOString() })`, and write them back (`platform.pods.manifest`/`manifest_hash`, and a new row in `pod_<slug>.policy_versions` with an incremented `version`).
5. **Confirm the DID document reflects the new key:**
   ```
   curl https://<PLATFORM_DOMAIN>/dids/<slug>/did.json
   ```
   The single `verificationMethod` entry's `publicKeyMultibase` should match `keyPair.publicKeyMultibase` from step 1.
6. **Verify the pod:**
   ```
   pnpm passport bioregion verify <slug>
   ```
   `manifest-signature` and `policy-signature` must pass; if you skipped re-signing the policy in step 4, `policy-signature` will still verify against the *old* key's proof but will no longer resolve, since the DID document no longer lists it — `verifyPod` will report that check failing.
7. **Tell active members.** Every member whose presentation depends on a VAC issued before the rotation needs to refresh their authorities or, if their membership pair itself predates the rotation and the pod's manifest/policy were re-signed, may need to re-run the ceremony. Post a notice in the pod's governance channel with the rotation date.

## Follow-up work

A graceful rotation (publishing both the old and new key in the DID document's `verificationMethod` array until every credential signed by the old key has expired, then retiring it) needs a code change to `podDidDocument`/`didDocumentFor` (currently single-key) and is out of scope for this runbook. Track it against ADR-027.
