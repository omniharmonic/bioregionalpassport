# ADR-026 — Single deployable (`apps/web`) instead of separate web apps per console

**Status:** accepted · MVP scope

## Context

The build set (B4 §2) lists four separate web front ends — `web-grants`, `web-directory`, `web-steward`, `web-operator` — alongside the mobile app. Four Vercel projects, four sets of environment variables and four deploy pipelines is more operational surface than a small team can run well while proving the product end to end, and the plan's tenancy model (host/path/header resolution, B2 §2.3) works just as well inside one Next.js app as across four.

## Decision

For MVP there is one deployable: `apps/web` (Next.js 16 App Router) hosts the landing page, the wallet PWA, every pod page (map, directory, events, grants, circulation) and every console (steward, operator), and mounts all pod-service and platform-service route handlers under `/api/<service>/…` via `mountService`. The services themselves (`services/pod-vta`, `trust-index`, `round`, `cc-gateway`, `pos-adapter`, `appview`, `control-plane`) stay separate packages exporting framework-agnostic handlers (`createXHandlers(deps)` / `routes` tables), specifically so they can be pulled out into their own deployables later without rewriting their logic.

## Consequences

`apps/web` is a single point of failure and a single scaling unit: a spike in one module's traffic (say, a payment rush) shares compute with every other module until the services are split out. Preview deploys and rollbacks are simpler (one Vercel project, one set of env vars) at the cost of coarser blast radius for any regression. Because the service packages never import Next.js and only export route tables, splitting a hot service into its own deployment later is a new thin host process wrapping the existing package, not a rewrite of the service's logic.
