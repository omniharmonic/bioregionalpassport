import { sha256 } from '@noble/hashes/sha2.js';
import { createResolver, toBase58btc, type DidResolver, type VerifiableCredential } from '@passport/credential-core';

const te = new TextEncoder();
export const utf8 = (s: string): Uint8Array => te.encode(s);

/** An error answered by a pod service: `{ code, message, hint? }` plus the HTTP status (0 = never reached it). */
export class PodError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'PodError';
  }
}

/** The one-sentence message to show for any thrown value. */
export function messageOf(err: unknown): string {
  if (err instanceof PodError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong; please try again.';
}

/** Plain base58btc (no multibase `z`) of sha256(text): 44 url-safe characters, matching the relay's channel rule. */
export function sha256Base58(text: string): string {
  return toBase58btc(sha256(utf8(text))).slice(1);
}

/** Relay channel id for an out-of-band invite: base58(sha256(challenge)) — only holders of the QR know it. */
export const channelFor = (challenge: string): string => sha256Base58(challenge);

/**
 * Relay channel for witness requests at one attestation event. MVP: derived from the public event id and task
 * digest, so anyone who can list the pod's events can read it (see the task report; a convener-shown event
 * secret is the follow-up).
 */
export const eventChannel = (event: { id: string; taskDigest?: string | null }): string =>
  sha256Base58(`org.bioregion.witness:${event.id}:${event.taskDigest ?? ''}`);

/** `did:key:z6MkhaXg…pQ2w` → `z6Mkha…pQ2w`; readable, never the whole identifier. */
export function abbreviateDid(did: string | undefined | null): string {
  if (!did) return '';
  const tail = did.startsWith('did:key:') ? did.slice(8) : did.startsWith('did:web:') ? did.slice(8).replace(/:/g, '/') : did;
  return tail.length <= 14 ? tail : `${tail.slice(0, 6)}…${tail.slice(-4)}`;
}

/** Platform domain from a pod's did:web (`did:web:example.org:dids:boulder` → `example.org`). */
export function platformDomainOf(podDid: string): string | undefined {
  if (!podDid.startsWith('did:web:')) return undefined;
  const host = podDid.slice(8).split(':')[0];
  return host ? decodeURIComponent(host) : undefined;
}

/** The domain pod presentations are bound to (`<slug>.<platformDomain>`, same as the VTA's `podDomain`). */
export function podDomainOf(slug: string, podDid: string): string {
  return `${slug}.${platformDomainOf(podDid) ?? 'localhost'}`;
}

const DTG_TYPES = [
  'MembershipCredential',
  'InvitationCredential',
  'RelationshipCredential',
  'StatementCredential',
  'DelegationCredential',
  'AuthorityCredential',
  'PersonaCredential',
] as const;

/** The DTG type of a credential (the non-`VerifiableCredential` entry of `type`). */
export function dtgType(vc: VerifiableCredential): string {
  const types = Array.isArray(vc.type) ? vc.type : [];
  return types.find((t) => (DTG_TYPES as readonly string[]).includes(t)) ?? types.find((t) => t !== 'VerifiableCredential') ?? 'VerifiableCredential';
}

export type CredentialKind =
  | 'membership-grant'
  | 'membership-ack'
  | 'relationship'
  | 'endorsement'
  | 'witness'
  | 'authority'
  | 'invitation'
  | 'delegation'
  | 'persona'
  | 'statement'
  | 'other';

/** A finer kind than the DTG type: which half of a pair, which statement predicate. */
export function credentialKind(vc: VerifiableCredential): CredentialKind {
  const t = dtgType(vc);
  const s = vc.credentialSubject ?? ({} as Record<string, any>);
  switch (t) {
    case 'MembershipCredential':
      return typeof s['digestMultibase'] === 'string' ? 'membership-ack' : 'membership-grant';
    case 'RelationshipCredential':
      return 'relationship';
    case 'StatementCredential':
      return s['predicate'] === 'dtg:endorses' ? 'endorsement' : s['predicate'] === 'dtg:witnessed' ? 'witness' : 'statement';
    case 'AuthorityCredential':
      return 'authority';
    case 'InvitationCredential':
      return 'invitation';
    case 'DelegationCredential':
      return 'delegation';
    case 'PersonaCredential':
      return 'persona';
    default:
      return 'other';
  }
}

/** Currently valid (validFrom ≤ now < validUntil; no validUntil = open-ended). */
export function isCurrent(vc: Pick<VerifiableCredential, 'validFrom' | 'validUntil'>, now: Date = new Date()): boolean {
  const t = now.getTime();
  if (vc.validFrom && Date.parse(vc.validFrom) > t + 5 * 60_000) return false;
  return !vc.validUntil || Date.parse(vc.validUntil) > t;
}

/** Authority actions carried by a VAC. */
export const vacActions = (vc: VerifiableCredential): string[] => {
  const a = vc.credentialSubject?.['authority']?.['actions'];
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
};

export const isOnline = (): boolean => {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return !nav || nav.onLine !== false;
};

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Stopped.', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Stopped.', 'AbortError'));
    }, { once: true });
  });

/** `include` for absolute URLs (another origin), `same-origin` for relative ones. */
export const credentialsFor = (url: string): RequestCredentials => (/^https?:\/\//i.test(url) ? 'include' : 'same-origin');

let sharedResolver: DidResolver | undefined;

/**
 * The wallet's DID resolver: did:key inline; did:web documents fetched from the page's own origin
 * (`/dids/<slug>/did.json`, which the platform app serves for every pod) when running in a browser, else from the
 * did:web URL. Documents are cached for 5 minutes (credential-core's resolver cache).
 */
export function defaultResolver(): DidResolver {
  sharedResolver ??= createResolver({
    webFetch: async (url: string) => {
      const loc = (globalThis as { location?: { origin?: string } }).location;
      const target = loc?.origin ? `${loc.origin}${new URL(url).pathname}` : url;
      const res = await fetch(target, { headers: { accept: 'application/did+json, application/json' } });
      if (!res.ok) throw new Error(`Could not resolve ${url} (${res.status}).`);
      return res.json();
    },
  });
  return sharedResolver;
}
