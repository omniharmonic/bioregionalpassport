# ADR-022 — Ceremony transport is QR + an HTTP relay instead of DIDComm

**Status:** accepted · MVP scope

## Context

The in-person attestation ceremony (B3 §5) — meet, exchange a Relationship Credential, ask a convener to witness, apply for membership, receive and acknowledge the Membership grant — is designed around DIDComm: an out-of-band QR invite, encrypted messages over a mediator, offline-first delivery. Standing up a DIDComm mediator is real infrastructure work with its own failure modes (message expiry, transport security, mobile push wake-ups) that has nothing to do with proving the ceremony itself works.

## Decision

For MVP the ceremony transport is a QR code carrying an out-of-band invite plus an HTTP relay (`services/pod-vta` relay endpoints: `POST /relay/:channel`, `GET /relay/:channel?after=<seq>`, channel = a hash of the OOB challenge, 24h TTL) with an IndexedDB outbox in the wallet for offline queuing and retry. Every message name and body follows B3 §5 exactly — the relay only replaces the transport envelope, not the protocol — so a DIDComm mediator can carry the same messages later without changing `packages/lexicons`' ceremony schemas or any ceremony state machine in the wallet.

## Consequences

The relay is a plaintext, platform-visible store-and-forward channel (bounded by a short TTL), not an encrypted, mediator-brokered one: message bodies are DTG-shaped and already carry their own proofs, but the relay operator can see message metadata and timing that a DIDComm mediator would not surface as easily. True offline-to-offline exchange (two phones with no connectivity to the platform) is not possible until a mediator exists; the MVP ceremony requires both devices to reach the pod's HTTP endpoint, even if not at the same moment. Swapping in DIDComm later is a transport-layer change behind the wallet's outbox interface.
