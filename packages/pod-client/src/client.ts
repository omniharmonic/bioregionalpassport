import {
  buildMembershipAck,
  createPresentation,
  digestMultibase,
  signDocument,
  type KeyPair,
  type VerifiableCredential,
  type VerifiablePresentation,
} from '@passport/credential-core';
import type { BioregionManifest } from '@passport/tenant-config';
import type { Tier } from '@passport/vocab';
import type { WalletDb } from './db.js';
import { ensureOk, Outbox, readBody, type FetchLike } from './outbox.js';
import type { RelayMessage, RelayTransport } from './relay.js';
import { credentialsFor, PodError, platformDomainOf, podDomainOf } from './util.js';

export type ServiceName = 'vta' | 'index' | 'appview' | 'gateway' | 'registry' | 'round';

export interface PodEvent {
  id: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  placeId: string | null;
  conveners: string[];
  attestation: boolean;
  taskDigest: string | null;
  taskDocument?: unknown;
  /** 'meeting' for the ad-hoc Trust Task a peer witness creates (`POST /witness`); scheduled gatherings are 'event'. */
  kind?: 'event' | 'meeting';
}

/** Where two neighbors met, optionally sent with a peer witness (`POST /witness`). */
export interface MeetingPlace {
  placeId?: string;
  lat?: number;
  lon?: number;
  name?: string;
}

export interface SessionInfo {
  token: string;
  subject: string;
  tier: Tier;
  authorities: string[];
  explanation: string[];
}

export interface AckResult {
  member: { did: string; tier: Tier };
  vacs: VerifiableCredential[];
  explanation: string[];
}

export interface RefreshResult {
  tier: Tier;
  issued?: boolean;
  vacs: VerifiableCredential[];
  explanation: string[];
  next?: { tier: Tier; missing: string[]; hints: string[] };
}

export interface CommitItem {
  commitment: string;
  scope: 'lives-here' | 'worked-with' | 'knows' | 'relationship';
  witnessRef?: string;
  evidence?: { vec: VerifiableCredential };
}

export interface PodClientOptions {
  slug: string;
  manifest?: BioregionManifest;
  /**
   * Service origin. `''` (the default in a browser on the platform or a pod host) = same origin: `/api/<service>`
   * with an `X-Pod` header, so the `passport_session` cookie set by the mount travels with every call.
   * Leave undefined to use the manifest's `services.*` URLs (another origin).
   */
  baseUrl?: string;
  fetch?: FetchLike;
  /** The persona this client signs with (sign-in, apply, ack, payments). */
  persona?: KeyPair;
  /** Wallet database for the outbox; without one requests are sent directly (never queued). */
  db?: WalletDb;
  outbox?: Outbox;
  now?: () => Date;
}

/**
 * Same origin only when the page is served from the platform host itself (or localhost in development): there
 * every pod is reachable as `/api/<service>` with an `X-Pod` header. On any other host — including another pod's
 * sub-domain — the client calls the pod's own origin (`services.*` in its manifest, i.e.
 * `https://<slug>.<platform>/api/...`) with `credentials: 'include'`, so one pod's credentials and session are
 * never sent to a different pod's host.
 */
export function isSameOrigin(manifest: BioregionManifest, origin: string | undefined): boolean {
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
  const platform = platformDomainOf(manifest.identity.did)?.split(':')[0]?.toLowerCase();
  return !!platform && host === platform;
}

/** Browser client for one pod's services, bound to its manifest (and optionally a persona). */
export class PodClient {
  readonly slug: string;
  readonly manifest: BioregionManifest | undefined;
  readonly baseUrl: string | undefined;
  readonly persona: KeyPair | undefined;
  readonly outbox: Outbox | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(opts: PodClientOptions) {
    this.slug = opts.slug;
    this.manifest = opts.manifest;
    this.persona = opts.persona;
    this.now = opts.now ?? (() => new Date());
    const f = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch?.bind(globalThis) as FetchLike | undefined);
    if (!f) throw new Error('No fetch implementation is available.');
    this.fetchImpl = f;
    const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
    this.baseUrl = opts.baseUrl ?? (opts.manifest && !isSameOrigin(opts.manifest, origin) ? undefined : '');
    this.outbox = opts.outbox ?? (opts.db ? new Outbox(opts.db, this.fetchImpl, this.now) : undefined);
  }

  /** A copy bound to another persona. */
  withPersona(persona: KeyPair): PodClient {
    return new PodClient({
      slug: this.slug,
      ...(this.manifest ? { manifest: this.manifest } : {}),
      ...(this.baseUrl !== undefined ? { baseUrl: this.baseUrl } : {}),
      fetch: this.fetchImpl,
      persona,
      ...(this.outbox ? { outbox: this.outbox } : {}),
      now: this.now,
    });
  }

  /** Base URL of a service: `/api/<service>` on the same origin, else the manifest's URL. */
  serviceUrl(service: ServiceName): string {
    if (this.baseUrl !== undefined) return `${this.baseUrl}/api/${service}`;
    const m = this.manifest;
    if (!m) throw new Error('A manifest or a base URL is needed to reach the pod.');
    const url =
      service === 'gateway'
        ? m.currency.node
        : service === 'round'
          ? `${new URL(m.services.vta).origin}/api/round`
          : m.services[service as 'vta' | 'index' | 'appview' | 'registry'];
    return url.replace(/\/+$/, '');
  }

  /** Domain presentations for this pod are bound to. */
  domain(): string {
    return podDomainOf(this.slug, this.manifest?.identity.did ?? '');
  }

  private headers(): Record<string, string> {
    return { 'x-pod': this.slug };
  }

  private requirePersona(): KeyPair {
    if (!this.persona) throw new Error('This passport has no identifier for this pod yet.');
    return this.persona;
  }

  async get<T = any>(service: ServiceName, path: string): Promise<T> {
    const req = { url: `${this.serviceUrl(service)}${path}`, method: 'GET', headers: this.headers() };
    const r = this.outbox ? await this.outbox.request(req) : await this.direct(req);
    return ensureOk(r) as T;
  }

  /** POST through the outbox. `durable` requests are kept and retried when offline (returns `{ queued: true }`). */
  async post<T = any>(service: ServiceName, path: string, body: unknown, opts: { durable?: boolean; label?: string } = {}): Promise<T | { queued: true }> {
    const req = { url: `${this.serviceUrl(service)}${path}`, method: 'POST', headers: this.headers(), body, ...(opts.label ? { label: opts.label } : {}) };
    if (!this.outbox) return ensureOk(await this.direct(req)) as T;
    const r = await this.outbox.enqueue(req, { durable: !!opts.durable });
    if (r.queued) return { queued: true };
    return ensureOk(r) as T;
  }

  private async postNow<T = any>(service: ServiceName, path: string, body: unknown): Promise<T> {
    const r = await this.post<T>(service, path, body);
    if (r && typeof r === 'object' && (r as { queued?: unknown }).queued === true) {
      throw new PodError(0, 'OFFLINE', 'You appear to be offline; connect and try again.');
    }
    return r as T;
  }

  private async direct(req: { url: string; method: string; headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; body: any }> {
    const init: RequestInit = { method: req.method, headers: { accept: 'application/json', ...(req.headers ?? {}) }, credentials: credentialsFor(req.url) };
    if (req.body !== undefined) {
      init.body = JSON.stringify(req.body);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await this.fetchImpl(req.url, init);
    } catch {
      throw new PodError(0, 'OFFLINE', 'You appear to be offline; connect and try again.');
    }
    return { status: res.status, body: await readBody(res) };
  }

  // ── sign-in ─────────────────────────────────────────────────────────────────────────────────────

  /** `GET /api/vta/challenge` → single-use challenge (5 min) and the domain to bind to. */
  async challenge(): Promise<{ challenge: string; domain: string; expiresAt?: string }> {
    return this.get('vta', '/challenge');
  }

  /** Signs `creds` into a VP bound to a fresh challenge. */
  async present(creds: VerifiableCredential[]): Promise<VerifiablePresentation> {
    const c = await this.challenge();
    return createPresentation(creds, this.requirePersona(), { challenge: c.challenge, domain: c.domain });
  }

  /** `POST /api/vta/session` with a VP of `creds`; the mount sets the `passport_session` cookie. */
  async session(creds: VerifiableCredential[], requireAuthority?: string[]): Promise<SessionInfo> {
    const presentation = await this.present(creds);
    return this.postNow('vta', '/session', { presentation, ...(requireAuthority?.length ? { requireAuthority } : {}) });
  }

  /** `POST /api/vta/session/visitor`: holder-only session at T0 (no credentials). */
  async visitorSession(): Promise<SessionInfo> {
    const presentation = await this.present([]);
    return this.postNow('vta', '/session/visitor', { presentation });
  }

  /** Clears the session cookie. */
  async signOut(): Promise<void> {
    await this.direct({ url: `${this.serviceUrl('vta')}/session`, method: 'DELETE', headers: this.headers() });
  }

  // ── events & witnessing ─────────────────────────────────────────────────────────────────────────

  async events(): Promise<PodEvent[]> {
    return (await this.get<{ events: PodEvent[] }>('vta', '/events')).events;
  }

  async event(id: string): Promise<PodEvent> {
    return this.get('vta', `/events/${encodeURIComponent(id)}`);
  }

  /** Conveners (`event:convene`): creates an attestation event. */
  async createEvent(input: { title: string; startsAt: string; endsAt: string; placeId?: string; description?: string }): Promise<PodEvent> {
    return this.postNow('vta', '/events', input);
  }

  /** Conveners (`vwc:issue`): `POST /events/:id/witness { vrcA, vrcB, evidence }` → the pod-signed VWC. */
  async witness(eventId: string, vrcA: VerifiableCredential, vrcB: VerifiableCredential, evidence: 'same-event' | 'liveness' = 'same-event'): Promise<VerifiableCredential> {
    const r = await this.postNow<{ vwc: VerifiableCredential }>('vta', `/events/${encodeURIComponent(eventId)}/witness`, { vrcA, vrcB, evidence });
    return r.vwc;
  }

  /**
   * Peer witnessing (`vwc:issue`, e.g. a Trusted member under `admission.witnessTier: 'T2'`): `POST /witness
   * { vrcA, vrcB, evidence: 'liveness', place? }` → the pod-signed VWC bound to a new meeting Trust Task.
   */
  async witnessMeeting(vrcA: VerifiableCredential, vrcB: VerifiableCredential, place?: MeetingPlace): Promise<{ vwc: VerifiableCredential; task: PodEvent }> {
    return this.postNow<{ vwc: VerifiableCredential; task: PodEvent }>('vta', '/witness', { vrcA, vrcB, evidence: 'liveness', ...(place ? { place } : {}) });
  }

  // ── membership ──────────────────────────────────────────────────────────────────────────────────

  /**
   * `POST /api/vta/membership/apply { vwc, presentation }`: the presentation is signed by the persona
   * (authentication, bound to a fresh challenge and the pod domain) and carries BOTH signed VRC halves of the
   * witnessed relationship. Returns the pod-signed membership grant.
   */
  async apply(vwc: VerifiableCredential, vrcA: VerifiableCredential, vrcB: VerifiableCredential): Promise<VerifiableCredential> {
    const presentation = await this.present([vrcA, vrcB]);
    const r = await this.postNow<{ grant: VerifiableCredential }>('vta', '/membership/apply', { vwc, presentation });
    return r.grant;
  }

  /** The persona's signed acknowledgement of `grant` (same validity window as the grant). */
  buildAck(grant: VerifiableCredential): VerifiableCredential {
    const persona = this.requirePersona();
    if (grant.credentialSubject?.id !== persona.did) throw new Error('This membership grant was issued to a different identifier.');
    if (!grant.validUntil) throw new Error('This membership grant has no end date.');
    const unsigned = buildMembershipAck({
      member: persona.did,
      pod: grant.issuer,
      grantDigest: digestMultibase(grant),
      validFrom: grant.validFrom,
      validUntil: grant.validUntil,
    });
    return signDocument(unsigned, persona);
  }

  /** `POST /api/vta/membership/ack { ack }` → T1 VACs and the explanation. Consent: only called after "I accept". */
  async ack(grant: VerifiableCredential): Promise<AckResult & { ackCredential: VerifiableCredential }> {
    const ack = this.buildAck(grant);
    const r = await this.postNow<AckResult>('vta', '/membership/ack', { ack });
    return { ...r, ackCredential: ack };
  }

  /** `POST /api/vta/authority/refresh` (member session): tier, current VACs, why, and what would change it. */
  async refresh(): Promise<RefreshResult> {
    return this.postNow('vta', '/authority/refresh', {});
  }

  async governance(): Promise<{ governance: BioregionManifest['governance']; policy: unknown; disclosure?: string }> {
    return this.get('vta', '/governance');
  }

  // ── trust index ─────────────────────────────────────────────────────────────────────────────────

  /** `POST /api/index/commit` (opt in; member session). */
  async commit(items: CommitItem[]): Promise<{ accepted: number; duplicates: number; rejected: number; items: unknown[] }> {
    return this.postNow('index', '/commit', { commitments: items });
  }

  async explanation(): Promise<{ tier: Tier; explanation: string[]; next?: { tier: Tier; missing: string[]; hints: string[] } }> {
    return this.get('index', '/me/explanation');
  }

  // ── relay (ADR-22) ──────────────────────────────────────────────────────────────────────────────

  /** Relay append; queued in the outbox when offline. */
  async relayPost(channel: string, sender: string, body: unknown): Promise<{ seq?: number; queued?: boolean }> {
    const label = typeof (body as { type?: unknown })?.type === 'string' ? String((body as { type: string }).type) : 'Relay message';
    return this.post('vta', `/relay/${encodeURIComponent(channel)}`, { sender, body }, { durable: true, label });
  }

  async relayList(channel: string, after = 0): Promise<RelayMessage[]> {
    return (await this.get<{ messages: RelayMessage[] }>('vta', `/relay/${encodeURIComponent(channel)}?after=${after}`)).messages;
  }

  /** This client as a `RelayTransport` for `Ceremony`. */
  relay(): RelayTransport {
    return { post: (c, s, b) => this.relayPost(c, s, b), list: (c, a) => this.relayList(c, a) };
  }

  // ── records, payments ───────────────────────────────────────────────────────────────────────────

  /** `POST /api/appview/records/:collection` (member session). */
  async postRecord(collection: string, record: Record<string, unknown>): Promise<unknown> {
    return this.postNow('appview', `/records/${encodeURIComponent(collection)}`, record);
  }

  /** `POST /api/gateway/pay/authorize { authorization }` (member session) → receipt. */
  async payAuthorize(authorization: unknown): Promise<{ receipt: any; balance?: number }> {
    return this.postNow('gateway', '/pay/authorize', { authorization });
  }
}

/** Platform registry: pods on this platform. Same origin by default. */
export async function listRegistryPods(opts: { baseUrl?: string; fetch?: FetchLike } = {}): Promise<{ slug: string; did: string; manifestUrl?: string }[]> {
  const f = opts.fetch ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  const res = await f(`${opts.baseUrl ?? ''}/api/registry/pods`, { headers: { accept: 'application/json' } });
  return ensureOk({ status: res.status, body: await readBody(res) }).pods ?? [];
}

/** Platform registry: one pod's manifest. */
export async function fetchPodManifest(slug: string, opts: { baseUrl?: string; fetch?: FetchLike } = {}): Promise<BioregionManifest> {
  const f = opts.fetch ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  const res = await f(`${opts.baseUrl ?? ''}/api/registry/pods/${encodeURIComponent(slug)}`, { headers: { accept: 'application/json' } });
  return ensureOk({ status: res.status, body: await readBody(res) }).manifest as BioregionManifest;
}
