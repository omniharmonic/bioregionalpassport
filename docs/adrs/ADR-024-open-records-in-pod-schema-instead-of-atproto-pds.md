# ADR-024 — Open records stored in the pod schema instead of an ATProto PDS/firehose

**Status:** accepted · MVP scope

## Context

The build set (B4 ADR-19) puts open records — enterprises, offers, needs, events, groups, projects, places — on ATProto: a shared `org.bioregion.*` lexicon namespace, each pod running (or federating to) a PDS, records flowing through a firehose so any indexer can build a map or directory from public data without asking the platform's permission. That is the right end state for an open-records layer, but a firehose and PDS are infrastructure the MVP does not need to stand up to prove the records model, the lexicon shapes, or the map/directory UI.

## Decision

For MVP, open records are stored directly in the pod's own Postgres schema in the same `org.bioregion.*` lexicon shape (`packages/lexicons`), served by `services/appview` (`GET /map`, `/directory`, `/search`, `/records/:collection[/:rkey]`, `/schema-org/:type`). Every record carries `bioregion` (the pod slug) and, where relevant, `placeId`, exactly as the lexicons define, so the record shape does not change when a PDS is introduced. Record URIs already use the `at://<slug>/org.bioregion.<collection>/<rkey>` form, with the pod slug standing in for the eventual repo DID.

## Consequences

Records are open in the sense that any pod service can read them freely, but there is no independent, platform-agnostic firehose yet: a third party cannot index Bioregional Passport's open records without going through the appview's HTTP API, and a pod cannot yet self-host its own PDS and keep serving the same firehose after leaving the platform. Migrating to a real PDS later means standing up the ATProto repo/firehose machinery and replacing the `records`/`offers` tables with PDS-backed storage; because the lexicon schemas and `bioregion`-tagged shape are already ATProto-correct, the appview's read routes should not need to change their response shapes, only their storage backend.
