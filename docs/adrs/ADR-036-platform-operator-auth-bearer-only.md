# ADR-036 — Platform-scope operator auth is Bearer-only in MVP

**Status:** accepted · ruled during implementation (`.superpowers/sdd/mvp/progress.md`, Task 9 mount obligation; Task 11 review)

## Context

Control-plane routes (`/api/control/*`: provision, manifest updates, export, health, tenant-zero) act on the platform, not on one pod. Task 11's first mount accepted either the `OPERATOR_TOKEN` bearer or a session carrying `registry:propose`. Review found that any pod's steward holding `registry:propose` in their own pod could then operate on every pod. A pod-scoped authority was treated as platform-scoped.

## Decision

In MVP, platform-scope operator routes accept only `Authorization: Bearer <OPERATOR_TOKEN>`, compared in constant time. A session never qualifies, whatever authorities it carries. An unset `OPERATOR_TOKEN` disables the routes. Plain Next.js route handlers outside the service mount (for example `/api/control/health`) use the same Bearer-only check. Request bodies are capped at 64 KB (256 KB on presentation routes).

## Consequences

Operator actions are a shared-secret capability held by the platform operator. There is no per-person audit of who used the token, so rotate it when staff change. A platform governance credential (a platform-issued `registry:*` VAC, checked against the platform DID and not a pod's) is the follow-up that would restore person-level operator auth.
