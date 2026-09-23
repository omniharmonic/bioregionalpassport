# ADR-040 — Pod re-issue after share-only recovery is deferred

**Status:** accepted · MVP scope (`.superpowers/sdd/mvp/progress.md`, Task 12 review)

## Context

FR-ID-5 covers recovery of a lost device. The wallet supports two routes. A full encrypted backup restores the wallet's keys and its stored credentials, including membership grants, acks and VACs. Share-only (social) recovery restores the holder's key from guardian shares but not the credentials. After share-only recovery the person has their DID back, but none of the pod-issued credentials that prove membership and tier. The build set expects the pod to re-issue them once the recovered DID proves control.

## Decision

For MVP the pod does not re-issue credentials after share-only recovery. A full backup restores membership. A person who recovers from shares alone rejoins through the normal ceremony or asks a steward, who can re-admit them. The pod-side re-issue flow is deferred: prove control of the recovered DID, check the existing `members` row, re-issue the VMC grant and the current VACs.

## Consequences

Share-only recovery is a key recovery, not a membership recovery. People without a full backup lose their pod credentials along with the device until they are re-admitted. Their `members` row, governance tier and index postings survive, so re-admission restores their standing. Adding re-issue later is a new pod-vta route plus a wallet action. It changes no existing credential shape.
