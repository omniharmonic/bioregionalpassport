# ADR-032 — Wallet canonical origin, platform-wide cookie, and pod-host redirects for wallet-dependent sections

**Status:** accepted · ruled during implementation (`.superpowers/sdd/mvp/progress.md`, Task 12 review; final review must-fix 2)

## Context

The wallet is a browser PWA (ADR-025) that keeps credentials in IndexedDB, which is scoped per origin. Every pod has its own host (`<slug>.<PLATFORM_DOMAIN>`). A wallet opened on each pod host would split one person's passport into several unrelated stores. Task 12's review also found that a pod-host wallet could send one pod's credentials to another pod. Task 14b separately ruled that pod-page client islands (credits, grants voting, merchant mode) read the wallet's IndexedDB on the same origin. The two rulings conflicted: at `<slug>.bioregionalpassport.org` those pages found "no passport on this device".

## Decision

The wallet has one canonical origin, the platform host. On a pod host the proxy redirects `/wallet…` (307) to `https://<PLATFORM_DOMAIN>/wallet…?pod=<slug>`. The session cookie is set with `Domain=.<PLATFORM_DOMAIN>`, so a session opened on the platform host reaches pod pages on every `<slug>.<PLATFORM_DOMAIN>`. The wallet-dependent pod sections `/grants`, `/circulation` and `/merchant`, and their subpaths, also redirect (307) from a pod host to `https://<PLATFORM_DOMAIN>/p/<slug><path>` with the query kept. Pod navigation links to those sections absolutely on a pod host. Home, map, directory, events, governance and the steward console stay on the pod host. In development `<slug>.localhost:<port>` maps to `localhost:<port>`.

## Consequences

There is one passport per person per device, and pod pages that need credentials always run where the credentials are. Visitors see the platform host in the address bar for grants, credits and merchant mode. Custom-domain pods (`POD_CUSTOM_DOMAINS`) do not share the platform cookie; their wallet sections still work because they redirect to the platform origin, but pod-host pages on a custom domain do not see the session. Known dev-only gap: `next start`/`next dev` rewrites a middleware redirect whose host matches the server's own host into a relative `Location`, so `<slug>.localhost` redirects to `localhost` can loop locally. Production hosts are unaffected.
