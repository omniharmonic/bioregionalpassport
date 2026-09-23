# ADR-038 — Challenges and the ceremony relay live in `platform.relay_messages`

**Status:** accepted · ruled during implementation (`.superpowers/sdd/mvp/progress.md`, Task 8 review)

## Context

ADR-030 makes every gate issue and consume a fresh challenge, and ADR-022 makes the ceremony transport an HTTP relay. Both first lived in process memory. On Vercel (ADR-026) each request can land on a different function instance. A challenge issued by one instance was unknown to the next, and relay messages disappeared between the two phones in a ceremony.

## Decision

Both use the platform database table `platform.relay_messages`, whose primary key `(channel, seq)` gives strict per-channel ordering. Challenges are rows on channel `challenge:<slug>`. They are single-use (consumed by deletion), expire after 5 minutes on the pod clock, and are never evicted by count, so a flood of `GET /challenge` cannot push out legitimate ones. Relay messages are rows on pod-scoped channels derived from the QR out-of-band challenge (16–128 url-safe characters). They live for 24 hours, are at most 64 KB each, and a channel holds at most 500 live messages (`CHANNEL_FULL` beyond that). The in-memory stores remain only as the fallback when no platform database is configured (tests, single-process runs).

## Consequences

Challenges and relay work across serverless instances, at the cost of a database round trip per challenge and per relay poll. Relay channels are readable by anyone who knows the channel id. Witness results posted there are public, which is why the index binds witness claims to edge parties (ADR-033). There is no per-IP or per-sender flood limit yet beyond the per-channel cap. Relay flood limits (a Vercel firewall rule or a rate limiter) are a recorded follow-up.
