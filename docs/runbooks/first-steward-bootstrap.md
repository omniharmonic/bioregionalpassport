# Runbook: bootstrap a pod's first steward

The normal path to becoming a T3 steward (convener) requires a Witness Credential from an *existing* T3+ convener at a physical event (B1 FR-TR-3, B3 §3). A freshly provisioned pod has no conveners yet, so its first steward has to be seeded by the operator directly — there is nobody who could witness them.

## Status

**Implemented as part of Task 8 (`services/pod-vta`)**, which was still in progress in this worktree as of this writing — check `.superpowers/sdd/mvp/task-8-report.md` and `services/pod-vta`'s git history for whether it has landed and whether this description still matches. If `services/pod-vta` does not yet exist or does not export `bootstrapSteward`, treat this runbook as the intended design (below) and mark the step "pending Task 8."

## What it does

`services/pod-vta/src/ceremony.ts` exports:

```ts
async function bootstrapSteward(
  ctx: VtaContext,
  deps: { podSigner } | { signer: PodSigner },
  did: string,
): Promise<{ member: { did: string; tier: 'T3' } } & { vacs: VerifiableCredential[]; explanation: string[] }>
```

It:
1. Inserts (or upgrades) a `members` row for `did` at tier `T3` directly — no membership grant/ack pair, no ceremony.
2. Issues a signed T3 `AuthorityCredential` (via the same PEP path normal tier upgrades use, `issueAuthorities`) carrying every T3 action from `packages/vocab`'s `tierDefaultActions('T3')`: `event:convene`, `vwc:issue`, `pep:review`, `registry:propose`, plus every T1/T2 action (`event:attend`, `vrc:exchange`, `vec:issue`, `round:comment`, `credit:account`, `credit:limit:L1`, `vec:issue:weighted`, `round:vote`, `round:propose`, `credit:limit:L2`, `vic:issue`, `group:create`).
3. Logs the reason in the VAC issuance log as "First steward bootstrap by the pod operator (B4 launch checklist)."

**It is explicitly documented in the source as operator-only and must never be mounted as a member-facing route** — nothing in `services/pod-vta`'s own route table calls it. It is meant to be invoked directly (by the control plane, an operator console action, or a one-off script), the same way `scripts/tenant-zero.mjs` calls `tenantZeroJob` directly rather than through HTTP.

## Who runs this, and when

The platform or pod operator, once, immediately after provisioning a new pod (`provision-pod.md`) and before onboarding any residents — the very first `event:convene` action needs somebody who already holds it.

## Procedure (once `@passport/pod-vta` is available)

There is no CLI command or console button for this yet (Task 15's operator console, and any CLI wiring, are not built). Until one exists, run it as a one-off script, following the same shape as `scripts/tenant-zero.mjs`:

1. Pick the DID of the person who will be the pod's first steward — typically a `did:key` persona they've already generated in the wallet (`/wallet` onboarding), shared with the operator out of band (not over an unauthenticated channel, since anyone who can call `bootstrapSteward` with an arbitrary DID becomes a T3 steward for that pod).
2. Build a `VtaContext` for the target pod (`{ slug, podDid, db, manifest, policy, now, platformDomain }` — the same shape every pod service handler receives) and a signer for the pod (`loadPodSigner(db, slug, masterKey)` from `@passport/control-plane`, passed as `{ podSigner: signer }`).
3. Call `bootstrapSteward(ctx, { podSigner }, stewardDid)` inside `withPod(db, slug, …)` (so the write lands in `pod_<slug>`, not the platform schema).
4. Confirm: query `pod_<slug>.members` for the DID and check `tier = 'T3'`; check `pod_<slug>.vac_issuance_log` for a fresh entry with the bootstrap explanation.
5. Tell the new steward they can now convene an attestation event (`POST /events`, once mounted) and witness edges (`POST /events/:id/witness`) — which is what everyone after them will use to join normally.

## Why this is safe enough for MVP, and what to watch for

- The T3 VAC this issues carries the same 90-day root validity ceiling as any other root authority credential (B3 §2) — it is not a permanent grant; the steward's authority lapses and must be refreshed like anyone else's once trust-index recomputation is wired up.
- Because there is no route for this, the only way to abuse it is direct database/code access with the pod's master key — the same access level that could already forge a pod's manifest or issue arbitrary VACs by hand. It does not introduce a new privilege boundary.
- Once Task 15's operator console exists, this should get a real, audited operator-only UI action rather than a one-off script, so there is a record of who ran it and when beyond the VAC issuance log's fixed explanation string.
