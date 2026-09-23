# Contributing

## Commits

Conventional commits: `feat(scope): …`, `fix(scope): …`, `docs(scope): …`, `test(scope): …`, `chore(scope): …`, `refactor(scope): …`. `scope` is usually the package or service directory (`credential-core`, `pod-vta`, `ci`, `adrs`). Commit only the paths your change actually touches — this is a shared workspace and other contributors' in-flight work lives alongside yours.

## Test-driven development

Write the failing test first, then the code that makes it pass. Every package's tests are colocated (`src/**/*.test.ts`) and run with `pnpm --filter <pkg> test`; both `typecheck` and `test` must pass before a change is considered done. Database-touching tests use PGlite (`@passport/db`'s `createTestDb()`), never a real Postgres connection — this keeps tests hermetic and fast, and keeps CI (`.github/workflows/ci.yml`) free of any database secret.

## PGlite tests

`createTestDb()` returns an in-memory Postgres-compatible database with the platform schema already migrated; `createTestPod(db, slug)` migrates a `pod_<slug>` schema on top of it when a test needs pod tables. Use `withPod(db, slug, fn)` the same way production code does, so a test that accidentally reaches across pod schemas fails the same way production would. Never point a test at `DATABASE_URL` — if a test needs a real Postgres feature PGlite doesn't support, that's worth raising, not working around with a live connection.

## Workspace build order

Packages export from `dist`, not `src` (`"exports"` in each `package.json`), so `pnpm -r build` must run before `pnpm -r test` or `pnpm -r typecheck` will resolve workspace-internal imports. `turbo.json` encodes this dependency (`build`/`typecheck`/`test` all depend on `^build`), so `pnpm -r build && pnpm -r test` (what CI runs) is the safe order from a clean checkout.

## ADR process

An architecture decision worth recording — a deviation from the build set, or a ruling made during implementation that future contributors need to know the reasoning behind — gets a file in `docs/adrs/`, numbered after the highest existing ADR, named `ADR-0NN-short-slug.md`. Follow the voice already there (`docs/build-set/11-passport-technical-architecture.md` §9, and `docs/adrs/ADR-021-*.md` onward): one paragraph of context, one of decision, one of consequences — terse, no filler. Add the new ADR to the table in `docs/adrs/README.md`. If the decision changes how a package's interface behaves, update `docs/dtg-compat.md`'s deviations list too when the change touches DTG-profile conformance.

## Before opening a PR

1. `pnpm -r build && pnpm -r typecheck && pnpm -r test` locally.
2. If your change touches `packages/verifier-sdk`'s vectors, regenerate them (`pnpm --filter @passport/verifier-sdk gen-vectors`) and confirm the diff is intentional.
3. If your change is a deviation from the build set or a ruling that resolves ambiguity in it, write the ADR in the same PR.
