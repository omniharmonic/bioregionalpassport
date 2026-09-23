# Runbook: export a pod / pod exit

Pod sovereignty (ADR-15 in the build set) means a pod can leave the platform with its identity, data and ledger intact. In MVP this is a single command that produces a complete JSON bundle; there is no automated "delete from the platform and self-host" step yet — that part is operational, not code.

## Who runs this

The pod operator, or the platform operator on request from a pod steward/anchor. Needs `DATABASE_URL` access; no `POD_KEY_ENCRYPTION_KEY` is needed for export (the encrypted private key is deliberately not part of the bundle — see "What's not included" below).

## Command

```
pnpm passport bioregion export <slug> > <slug>-export.json
```

This is `packages/cli`'s `bioregion export` command, calling `services/control-plane`'s `exportPod(db, slug)` and writing the JSON to stdout. There is no `--json` flag needed — `export` always prints JSON (unlike `create`/`verify`/`list`, which default to a human-readable table).

## What's in the bundle (`PodExport`, `services/control-plane/src/export.ts`)

```ts
interface PodExport {
  manifest: BioregionManifest;   // the pod's current signed manifest
  didDocument: DidDocument | null; // derived live from platform.pod_keys, same as GET /dids/<slug>/did.json
  policy: TrustPolicy | null;    // the latest signed trust policy
  tables: Record<string, Record<string, unknown>[]>; // every base table in pod_<slug>, by table name
}
```

`tables` is every table in the pod's own schema (`pod_<slug>`) via `information_schema.tables` — `members`, `edge_commitments`, `witness_refs`, `events`, `vac_issuance_log`, `policy_versions`, `groups`, `rounds`, `proposals`, `ballots`, `adjustments`, `enterprises`, `acceptance_rules`, `accounts`, `ledger_entries`, `commitments`, `pos_grants`, `disputes`, `records`, `offers`, and `_migrations`, plus any pod tables added by later tasks — nothing is hardcoded or hand-picked, so the export stays complete as the schema grows. Values are made JSON-safe (`bigint` → string, `Date` → ISO 8601, `Uint8Array` → byte array).

## What's *not* included

- **The pod's encrypted private key** (`platform.pod_keys.encrypted_private_key`). The export gives the pod's public identity (DID document) and everything it needs to *verify* its own history, but not the ability to sign as itself. A pod taking its data to self-host needs a **separate, explicit key hand-off** — decrypt the key with the platform's `POD_KEY_ENCRYPTION_KEY` (see `rotate-pod-key.md` for the decrypt call shape) and transfer it out of band, or generate a brand-new key for the self-hosted deployment and re-anchor governance to it. This is a deliberate gap, not an oversight: a bundle that included the raw signing key would make `bioregion export` itself a key-exfiltration path.
- **Other pods' data.** `exportPod` only ever reads `pod_<slug>`'s own schema (there is no cross-pod query path anywhere in the codebase), so the bundle cannot leak another pod's records even by mistake.

## Verifying an export

- `didDocument.verificationMethod[0].publicKeyMultibase` should match what `GET https://<PLATFORM_DOMAIN>/dids/<slug>/did.json` returns at the same moment.
- `manifest.proof` and `policy.proof` should verify against `didDocument` (this is exactly what `pnpm passport bioregion verify <slug>`'s `manifest-signature`/`policy-signature` checks already do — run that first).
- `tables._migrations` (if present) lists every migration that has been applied to the pod's schema, which is useful context for whoever re-imports the bundle into a fresh database.

## Using the export to exit

1. Run `bioregion export <slug>` and archive the JSON somewhere durable (not committed to this repository).
2. Separately, and only with the pod's/platform's agreement, hand off the decrypted signing key (see "What's not included" above) or agree that the exiting pod will mint a new key and the two histories fork from the export point.
3. Stand up a new instance of the pod services (or any DTG/VC 2.0-conformant replacement) that can read the JSON bundle's `tables` and `manifest`/`policy` shapes — the record and credential shapes are the same ones documented in `docs/dtg-compat.md` and `packages/lexicons`, so nothing in the bundle is Bioregional-Passport-proprietary.
4. Once the new deployment is live, remove the pod from this platform's registry (`platform.registry_entries`) and stop routing its subdomain here — there is no CLI command for this step yet; it is a manual database and DNS change (see `infra/README.md`).
