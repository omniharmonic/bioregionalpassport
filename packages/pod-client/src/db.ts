import Dexie, { type EntityTable } from 'dexie';
import type { DidScope, VerifiableCredential } from '@passport/credential-core';
import type { BioregionManifest } from '@passport/tenant-config';
import type { Tier } from '@passport/vocab';
import type { CredentialKind } from './util.js';

export const DEFAULT_DB_NAME = 'passport-wallet';

/**
 * A key the wallet holds. `seed` is the 32-byte Ed25519 secret.
 *
 * MVP (ADR-25): seeds are stored as raw bytes in IndexedDB, which the browser keeps per origin. They never leave
 * the device except inside the passphrase-encrypted backup or the recovery shares the person makes themselves.
 * Encrypting them at rest under a non-extractable WebCrypto device key (and a hardware keystore in the native
 * app) is the follow-up.
 */
export interface IdentifierRow {
  did: string;
  scope: DidScope;
  /** Pod slug for directed personas and pairwise identifiers. */
  pod?: string;
  /** Pairwise identifiers: the other person's DID, once known. */
  counterparty?: string;
  seed: Uint8Array;
  createdAt: string;
}

/** A credential held in the wallet, stored exactly as received. */
export interface CredentialRow {
  /** digestMultibase(raw) */
  digest: string;
  /** DTG type, e.g. `MembershipCredential`. */
  type: string;
  kind: CredentialKind;
  pod?: string;
  issuer: string;
  subject: string;
  validUntil?: string;
  raw: VerifiableCredential;
  receivedAt: string;
  /** `superseded` once the pod no longer lists it among the holder's current authorities. */
  status?: 'active' | 'superseded';
}

export interface PodExplanation {
  tier: Tier;
  explanation: string[];
  next?: { tier: Tier; missing: string[]; hints: string[] };
  at: string;
}

export interface PodRow {
  slug: string;
  manifest: BioregionManifest;
  /** The pod's DID. */
  did: string;
  /** The persona (directed identifier) this wallet uses with the pod. */
  personaDid: string;
  tier?: Tier;
  effectiveUntil?: string;
  /** When the membership pair completed (absent while a visitor). */
  joinedAt?: string;
  addedAt: string;
  lastExplanation?: PodExplanation;
}

export interface ContactRow {
  /** The neighbor's DID in this relationship. */
  did: string;
  pod: string;
  /** A local nickname, never shared. */
  name?: string;
  /** My signed half (issuer = me). */
  vrcOut?: VerifiableCredential;
  /** Their signed half (issuer = them). */
  vrcIn?: VerifiableCredential;
  formedAt: string;
  /** My DID in this relationship. */
  myDid: string;
  /** Pair digest (see pod-vta edges.ts). */
  edgeDigest?: string;
  /** The ceremony relay channel, reused to deliver vouches later. */
  channel?: string;
  /** Last relay seq read on `channel`. */
  lastSeq?: number;
  event?: string;
  vecOut?: VerifiableCredential;
  vecIn?: VerifiableCredential;
  /** Set when I asked a convener to witness this relationship ("I'm here"). */
  witnessRequested?: { event: string; at: string };
  /** Digests of witness credentials the pod refused at apply (never picked up again). */
  refusedVwcs?: string[];
  /** The pod's witness credential for this relationship. */
  vwc?: VerifiableCredential;
  /** Trust-index commitments made for this relationship (opt in). */
  committed?: { scope: string; commitment: string; at: string }[];
}

export interface EventRow {
  id: string;
  pod: string;
  title: string;
  startsAt: string;
  endsAt?: string;
  channel?: string;
  taskDigest?: string;
  conveners?: string[];
  attestation?: boolean;
  placeId?: string | null;
}

export interface OutboxRow {
  id?: number;
  url: string;
  method: string;
  headers?: Record<string, string>;
  body: unknown;
  createdAt: string;
  attempts: number;
  lastError?: string;
  /** Human label, e.g. "Relationship offer". */
  label?: string;
}

export interface SettingRow {
  key: string;
  value: unknown;
}

/** IndexedDB database `passport-wallet` (ADR-25). */
export class WalletDb extends Dexie {
  identifiers!: EntityTable<IdentifierRow, 'did'>;
  credentials!: EntityTable<CredentialRow, 'digest'>;
  pods!: EntityTable<PodRow, 'slug'>;
  contacts!: EntityTable<ContactRow, 'did'>;
  events!: EntityTable<EventRow, 'id'>;
  outbox!: EntityTable<OutboxRow, 'id'>;
  settings!: EntityTable<SettingRow, 'key'>;

  constructor(name: string = DEFAULT_DB_NAME) {
    super(name);
    this.version(1).stores({
      identifiers: 'did, scope, pod, counterparty',
      credentials: 'digest, type, kind, pod, issuer, subject',
      pods: 'slug',
      contacts: 'did, pod',
      events: 'id, pod',
      outbox: '++id, createdAt',
      settings: 'key',
    });
  }
}
