# Bioregional Passport

A multi-bioregion platform for place-based identity, trust, funding and exchange. Each bioregion runs its own **pod** — a verifiable trust community with its own identity, branding, governance, trust policy, currency and app front end — on shared open protocols, so that trust and credentials travel between pods and no platform or state issues the identity.

Residents prove who they are to each other in person, vouch for one another, join groups, fund projects with trust-weighted votes, and trade in a local mutual-credit currency that is never sold for dollars. Boulder is the first pod; the platform is built to onboard a second bioregion with a customised front end from day one, proven in CI by a synthetic pod ("tenant zero") that is provisioned and verified on every push to `main` and nightly.

## Monorepo layout

| Path | What it is |
|---|---|
| `apps/web` | Next.js 16 App Router — landing, wallet PWA, pod pages (map/directory/events/grants/circulation), operator and steward consoles, and every service's API mount under `/api/<service>/…` |
| `packages/credential-core` | DIDs, DataIntegrityProof signing/verification, DTG credential builders, attenuation, delegation chains, backup/recovery |
| `packages/verifier-sdk` | `verifyDTG` + policy + session helpers + conformance vectors |
| `packages/tenant-config` | Bioregion manifest + trust policy schemas/validators, the Boulder and tenant-zero manifests, manifest signing |
| `packages/vocab` | Authority scopes, tiers, predicates |
| `packages/lexicons` | zod schemas for `org.bioregion.*` open records and protocol messages (ceremony, pay) |
| `packages/db` | Postgres adapter (`postgres.js` for Neon, PGlite for tests), migration runner, `withPod` tenant scoping, platform + pod migrations |
| `packages/service-kit` | Shared `PodContext`/`Route`/`ServiceError` contract every service handler is built on |
| `packages/ui-kit` | Theme provider driven by the manifest, base React components, Tailwind preset |
| `packages/cli` | `passport` — the operator CLI (`bioregion create/verify/export/list`, `platform migrate`) |
| `services/pod-vta` | Membership/ack, policy enforcement point (VAC issuance), audit, governance, ceremony relay, DID document hosting |
| `services/trust-index` | Trust commitments, tier scorer, explanations, anomaly flags |
| `services/control-plane` | Pod provisioning (idempotent), manifest registry, TRQP-style registry, export, tenant-zero job |
| `services/appview` | Open records (enterprise/offer/need/event/group/project/place), map/directory/search, schema.org, place resolution |
| `services/round` *(planned)* | Grants rounds, proposals, quadratic-voting ballots, tally, publication |
| `services/cc-gateway` *(planned)* | Mutual-credit ledger: accounts, limits, pay/authorize, receipts, steward exposure, disputes, exports |
| `services/pos-adapter` *(planned)* | Point-of-sale adapter interface + manual-tender adapter + reconcile queue |
| `infra/` | Infrastructure notes: Neon, Vercel, DNS, secrets policy — see `infra/README.md` |
| `docs/` | The build set (product/architecture/protocol/implementation), ADRs, runbooks, `dtg-compat.md`, session plans |

Every package builds to `dist/` and is imported by its built output (`"exports"` in `package.json`), so a fresh checkout must run `pnpm -r build` before `pnpm -r test` or `pnpm -r typecheck` will resolve workspace imports.

## Quickstart

```sh
pnpm install
pnpm -r build
pnpm -r test

cp .env.example .env
# fill in DATABASE_URL (a Neon or any Postgres connection string), POD_KEY_ENCRYPTION_KEY
# (64 hex characters), PLATFORM_DOMAIN, SESSION_SECRET

pnpm passport platform migrate
pnpm passport bioregion create --manifest boulder
pnpm passport bioregion create --manifest tenant-zero

pnpm --filter web dev
```

`pnpm passport …` runs `packages/cli`'s `passport` binary against the workspace build. See `docs/runbooks/provision-pod.md` for what each provisioning step does and how to verify a pod, and `docs/runbooks/` generally for operational procedures (key rotation, adding a governance anchor, pod export/exit, bootstrapping a pod's first steward).

## Three planes, one new axis

- **Trust plane** — credentials live in people's wallets, never on a public feed. Verifiable Credentials 2.0 with `DataIntegrityProof`/`eddsa-jcs-2022` (see `docs/dtg-compat.md`), issued peer-to-peer and by each pod's policy enforcement point, never by the platform.
- **Open plane** — records (enterprises, offers, needs, events, groups, projects, places) are open: anyone can read them from a pod's AppView, tagged with the pod's `bioregion` so cross-pod discovery is possible without cross-pod coupling.
- **Value plane** — a mutual-credit ledger and quadratic-voting grants rounds, both gated by presented credentials, never by an account system separate from the trust plane.
- **Tenancy** (the new axis) — every pod is a `did:web` identity, a Postgres schema (`pod_<slug>`), a manifest, a theme and a trust policy. Every pod-service request resolves a tenant from custom domain → `<slug>.<platform domain>` → path prefix → header, and there is no cross-pod query path anywhere in the codebase — enforced by `withPod`, which scopes every pod database transaction to its own schema.

See `docs/build-set/11-passport-technical-architecture.md` §1–2 for the full picture and `docs/plans/2026-09-22-mvp-plan.md` §1 for the constraints this MVP build holds to.

## Documentation

- **Build set** (product, architecture, protocol, implementation) — `docs/build-set/`
- **MVP session plan** and its deviations from the build set — `docs/plans/2026-09-22-mvp-plan.md`
- **Architecture decision records** — `docs/adrs/` (ADR 1–20 in the build set; ADR 21–30 recorded here for the MVP)
- **DTG compatibility log** — `docs/dtg-compat.md`
- **Runbooks** — `docs/runbooks/`
- **Infrastructure** (Neon, Vercel, DNS, secrets) — `infra/README.md`
- **Contributing** — `CONTRIBUTING.md`

## Licence

Apache-2.0 — see `LICENSE`.
