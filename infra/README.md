# Infrastructure

Bioregional Passport's MVP infrastructure is deliberately small: one Postgres database, one Vercel deployable, and DNS records pointed at Vercel. This file records the facts an operator needs — project names, regions, the env var list, and the secrets policy — not step-by-step setup (see `docs/runbooks/` for operational procedures like provisioning a pod or rotating a key).

## Database — Neon

- **Project name:** `bioregional-passport`
- **Region:** `us-west-2`
- **Database:** `passport`
- **Isolation:** schema-per-pod (ADR-16 in the build set). The platform's own tables live in the `platform` schema; each pod's tables live in `pod_<slug>` (slug with `-` normalized to `_`). There is no cross-pod query path — every pod-scoped query runs inside `withPod(db, slug, …)`, which sets `search_path` for the transaction.
- **Migrations:** `packages/db`'s migration runner (`migratePlatform`, `migratePod`), applied via `pnpm passport platform migrate` and automatically as part of `pnpm passport bioregion create` (see `docs/runbooks/provision-pod.md`). Tenant-zero acts as the migration canary — it is provisioned and verified before Boulder on every deploy.
- **Tests never touch Neon.** `packages/db`'s `createTestDb()` runs an in-memory PGlite instance instead; this is enforced by convention (every package's tests use `createTestDb`), not by a network block.

## Deployment — Vercel

- **Team:** `omniharmonics-projects`
- **Deployable:** a single Next.js project rooted at `apps/web` (ADR-026 — one deployable hosts every pod page, console, the wallet PWA, and mounts every service's routes under `/api/<service>/…`).
- **Build:** `pnpm -r build` at the workspace root (Vercel's install step runs `pnpm install`; the project's build command must build the workspace, not just `apps/web`, since `apps/web` imports every package from its `dist/` output).

### Environment variables (set in the Vercel project, per environment)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon connection string for the `passport` database (`?sslmode=require`) |
| `POD_KEY_ENCRYPTION_KEY` | 64 hex characters (32 bytes); AES-256-GCM key that encrypts every pod's signing key at rest (ADR-027) |
| `PLATFORM_DOMAIN` | `bioregionalpassport.org` in production; the platform's own preview/staging domain in preview deployments |
| `SESSION_SECRET` | Signs session cookies issued after `verifyDTG` (`@passport/verifier-sdk`'s `createSession`/`readSession`) — at least 32 bytes |
| `OPERATOR_TOKEN` | Break-glass bearer token for the first pod operator, until an operator's own `authority:pep:review`/steward VAC session can be used instead |

See `.env.example` at the repo root for local development; never set these as literal values in `vercel.json` or any committed file.

## DNS — Namecheap

`bioregionalpassport.org` is registered and managed at Namecheap with basic DNS (no separate nameserver delegation to Vercel).

| Host | Type | Value |
|---|---|---|
| `@` | A | `76.76.21.21` |
| `www` | CNAME | `cname.vercel-dns.com` |
| `boulder` | CNAME | `cname.vercel-dns.com` |
| `tenant-zero` | CNAME | `cname.vercel-dns.com` |

Each pod subdomain must also be added as a domain on the Vercel project (Vercel won't serve traffic for a domain it hasn't been told about, even if DNS points at it) and, if the pod uses a custom domain rather than a `<slug>.bioregionalpassport.org` subdomain, that domain's own DNS needs the same CNAME (or an A record to `76.76.21.21` for an apex domain).

### Adding a pod's subdomain

1. Provision the pod (`docs/runbooks/provision-pod.md`) so `PLATFORM_DOMAIN` + `identity.slug` produce the intended `<slug>.bioregionalpassport.org`.
2. Add a CNAME record: host `<slug>`, value `cname.vercel-dns.com`.
3. Add `<slug>.bioregionalpassport.org` as a domain on the Vercel project (dashboard, or `vercel domains add`).
4. Confirm `apps/web`'s tenant-resolution middleware (host → `x-pod` header → `<slug>` rewrite) picks up the new subdomain — it resolves from the manifest already stored in `platform.pods`, so no code change is needed per pod.

## Secrets policy

- **Never commit `.env`.** It's already gitignored; `.env.example` documents the variable names with no real values.
- `POD_KEY_ENCRYPTION_KEY` and `SESSION_SECRET` live only in Vercel's environment variable store (and developers' local `.env` files) — never in a manifest, a migration, or a seed script.
- A pod's decrypted signing key is never written to logs, never returned from any API response, and never included in `pnpm passport bioregion export`'s output (see `docs/runbooks/pod-export-exit.md`).
- Rotating `POD_KEY_ENCRYPTION_KEY` itself (as opposed to rotating one pod's signing key) means re-encrypting every row in `platform.pod_keys` — not yet scripted; treat as a database migration, tested against a copy first.
