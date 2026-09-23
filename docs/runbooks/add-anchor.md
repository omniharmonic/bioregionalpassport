# Runbook: add a governance anchor to a pod

A pod's anchors (`manifest.governance.anchors`) are the DIDs the platform registry treats as co-signers of the pod's identity — the `GET /api/registry/authorization` check matches `authority=anchor` requests against this list (`services/control-plane/src/registry.ts`). Adding an anchor is a manifest edit, re-signed and re-provisioned like any other manifest change.

## Who runs this

The pod operator (or the platform operator on the pod's behalf), with the same `DATABASE_URL` / `POD_KEY_ENCRYPTION_KEY` / `PLATFORM_DOMAIN` access as `provision-pod.md`.

## Steps

1. **Fetch the pod's current signed manifest** (from `platform.pods.manifest`, or `pnpm passport bioregion export <slug>` and read the `manifest` key of the JSON bundle it prints).
2. **Edit `governance.anchors`.** It's a plain array of DIDs on the manifest object:
   ```json
   {
     "governance": {
       "url": "https://boulder.bioregionalpassport.org/governance",
       "disclosure": "Member identifiers are never disclosed beyond the pod VTA.",
       "anchors": ["did:key:z6Mk…existingAnchor", "did:key:z6Mk…newAnchor"],
       "disputes": "disputes@boulder.bioregionalpassport.org"
     }
   }
   ```
   Strip out any `proof` block from the file before resubmitting — `provisionPod` strips an incoming `proof` itself, but it's clearer to not carry a stale one. `identity.slug` must be unchanged (the control routes reject a manifest whose slug doesn't match the URL's `:slug` with `400 SLUG_MISMATCH`).
3. **Resubmit the manifest.** Two equivalent paths:
   - CLI: `pnpm passport bioregion create --manifest ./edited-manifest.json` (works for any slug; re-provisioning an existing pod only touches what changed).
   - API (once `apps/web` mounts `services/control-plane`'s control routes, Task 11): `PUT /api/control/pods/<slug>/manifest` with the edited manifest as the body, authenticated as operator.
4. **Confirm the step ran.** The CLI's step table (or the JSON response's `steps[]`) should show `manifest: updated` with the new content hash. If it instead shows `manifest: unchanged`, the anchors array wasn't actually different from what's stored (check for a stray whitespace/ordering difference — `manifestHash` hashes the manifest's JSON-canonicalized content, so array order matters).
5. **Verify.** `pnpm passport bioregion verify <slug>` re-checks `manifest-signature`, and `curl https://<slug>.<PLATFORM_DOMAIN>/api/registry/authorization?entity=<newAnchorDid>&authority=anchor&context=<podDid>` (once the registry routes are mounted) should return `{authorized: true}`.

## Removing an anchor

Same procedure with the DID removed from the array. There is no separate "remove" operation — the anchors list in the manifest is the source of truth, and the registry entry is fully replaced on each successful `manifest` step.

## Notes

- Anchors are informational/governance co-signers for MVP (ADR-021: the pod's own `did:web` document has one signing key, not a DID log with witnesses) — adding an anchor here does not itself add a verification method to the pod's DID document. It only changes what `GET /api/registry/authorization?authority=anchor` reports.
- Anchor DIDs should be `did:key` identifiers for real people (the pod's T4 co-signers per B1 §3), not the pod's own DID.
