# Runbook: provision a pod

Turns a bioregion manifest into a working pod: a signed `did:web` identity, a Postgres schema, a signed trust policy, a registry entry, and (optionally) demo open records. Provisioning is idempotent — running it again with the same manifest reports every step `unchanged` and leaves the pod's DID untouched.

## Who runs this

The platform operator, from a machine (or CI job) with database access. There is no member-facing route for this; it is `packages/cli`'s `bioregion create` command, or the operator-only `POST /api/control/pods` / `PUT /api/control/pods/:slug/manifest` routes once `apps/web` mounts `services/control-plane`'s `createControlRoutes()` (Task 11 — not live yet).

## Environment variables

Read from the process environment, or from `<repo>/.env` (the CLI's small `.env` parser walks up from the current directory to find the repo root by locating `pnpm-workspace.yaml`, and never overrides a variable already set). See `.env.example` at the repo root.

| Variable | Required for | Notes |
|---|---|---|
| `DATABASE_URL` | every command | Postgres connection string (Neon in staging/prod; PGlite is used automatically in tests, never here) |
| `POD_KEY_ENCRYPTION_KEY` | `create`, `verify` | 64 hex characters (32 bytes) — AES-256-GCM key that encrypts each pod's signing key at rest (ADR-027) |
| `PLATFORM_DOMAIN` | all | default `bioregionalpassport.org`; the pod's `did:web` and subdomain are derived from this |

## Steps

1. Make sure the platform schema exists (safe to run every time; it is idempotent):
   ```
   pnpm passport platform migrate
   ```
2. Provision a pod from a built-in manifest (`boulder` or `tenant-zero`) or a manifest file:
   ```
   pnpm passport bioregion create --manifest boulder
   pnpm passport bioregion create --manifest tenant-zero
   pnpm passport bioregion create --manifest ./path/to/manifest.json
   ```
   Add `--json` for machine-readable output (a `{slug, did, manifest, steps}` object — see below).
3. Verify the pod is fully working:
   ```
   pnpm passport bioregion verify boulder
   ```
   Exits non-zero if any check fails.
4. List every provisioned pod:
   ```
   pnpm passport bioregion list
   ```

`pnpm passport …` is the root script `pnpm --filter @passport/cli exec passport`; the same commands work as `pnpm --filter @passport/cli exec passport bioregion create --manifest boulder` from anywhere in the repo, or as `node dist/bin.js …` from inside `packages/cli` after `pnpm --filter @passport/cli build`.

## What each provisioning step does (`services/control-plane/src/provision.ts`, `provisionPod`)

Each step reports a status of `created`, `updated` or `unchanged`.

1. **validate** — validates the manifest against `@passport/tenant-config`'s `ManifestSchema` (rejects a higher schema major); computes the pod's `did:web` from `PLATFORM_DOMAIN` and the manifest's `identity.slug`, overriding whatever `identity.did` the manifest carried (the platform always hosts the DID document at `https://<PLATFORM_DOMAIN>/dids/<slug>/did.json`).
2. **pod-key** — generates a fresh Ed25519 key pair if the pod has none yet, encrypts the private key with `POD_KEY_ENCRYPTION_KEY` (AES-256-GCM, `services/control-plane/src/keys.ts`), and stores it in `platform.pod_keys`. A wrong `POD_KEY_ENCRYPTION_KEY` fails this step immediately with a plain-sentence error, since the key is decrypted right after storing it.
3. **did-document** — nothing is stored separately; `GET /dids/<slug>/did.json` is always derived live from the current `platform.pod_keys` row.
4. **schema** — creates `pod_<slug>` if it doesn't exist and applies every pending `migrations/pod/*.sql` file, tracked in `pod_<slug>._migrations`.
5. **trust-policy** — writes trust-policy version 1 (`@passport/tenant-config`'s `defaultTrustPolicy(did)`, signed by the pod key) only if the pod's `policy_versions` table is empty. It does **not** re-sign or bump the policy on a later run — see `rotate-pod-key.md` for the corresponding gap when the signing key changes.
6. **manifest** — signs the manifest (`eddsa-jcs-2022`, `proofPurpose: assertionMethod`) and upserts `platform.pods`, but only when the manifest's content hash (`manifestHash`, computed over the manifest *without* the `proof`) differs from what's stored. Re-running `bioregion create` with an unchanged manifest file reports `manifest: unchanged` and returns the exact same signed bytes.
7. **registry** — upserts `platform.registry_entries` (`did`, `governance.anchors`, `accepted_issuers: [did]`, `vocab_version`), read by the TRQP-style registry routes (`GET /api/registry/authorization|recognition|pods`).
8. **seed-records** — only runs when the caller (the CLI, via `loadServiceDeps()`) can dynamically import `@passport/appview`'s `seedDemoRecords`. Seeds a handful of demo enterprises, events, groups and offers per bioregion (8/3/2/3/2 for Boulder, smaller sets for tenant-zero and any other slug). Reports `unchanged, "no seeder configured"` if `@passport/appview` isn't resolvable.

## How to verify

`pnpm passport bioregion verify <slug>` runs `services/control-plane/src/verify.ts`'s `verifyPod`, which checks (each reported independently, `ok`/`skipped`/failure detail):

- **did-document** — the pod's DID document resolves and a probe document signs/verifies against it.
- **manifest-signature** — the stored manifest's `proof` verifies against the pod's DID document.
- **policy-signature** — the latest trust policy's `proof` verifies and its controller is the pod DID.
- **schema** — no pending pod migrations.
- **vta-ceremony**, **ledger-transfer**, **appview-record** — smoke-tests the back half of the ceremony, a two-account ledger transfer, and a record write/read/delete, each via a duck-typed dependency (`deps.vta.ceremonyBackHalf`, `deps.gateway.smokeTransfer`, `deps.appview.smokeRecord`). Reported `ok: true, skipped: true` when the corresponding service package isn't available yet (as of this writing, `services/pod-vta` and `services/cc-gateway` are still landing) — a skip is not a failure.

For `tenant-zero` specifically, every verify run (via `tenantZeroJob`, `.github/workflows/tenant-zero.yml`, or `scripts/tenant-zero.mjs`) is additionally recorded in `platform.tenant_zero_runs`.
