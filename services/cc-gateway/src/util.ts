import type { DidResolver } from '@passport/credential-core';
import type { Db } from '@passport/db';
import type { MessageSigner, PosAdapter } from '@passport/pos-adapter';
import { ServiceError, type PodContext, type Route, type RouteRequest, type SessionClaims } from '@passport/service-kit';
import type { BioregionManifest, TrustPolicy } from '@passport/tenant-config';
import type { StatusFetch } from '@passport/verifier-sdk';
import { TIERS, tierRank, type Tier } from '@passport/vocab';

/** Pod context as seen by the gateway (`db` already scoped by `withPod`). */
export type GatewayContext = PodContext<BioregionManifest, TrustPolicy, Db>;
export type GatewayRoute = Route<GatewayContext>;

export interface GatewayDeps {
  resolver: DidResolver;
  /** Signs payment requests, receipts and merchant root VACs as the pod. */
  podSigner: MessageSigner;
  /** Optional status-list fetcher for VAC revocation checks at `/pay/authorize`. */
  statusFetch?: StatusFetch;
  /** POS adapter used by `/pay/:id/tender` (defaults to the manual adapter). */
  adapter?: PosAdapter;
}

export const DAY_MS = 86_400_000;
export const addMs = (d: Date, ms: number): string => new Date(d.getTime() + ms).toISOString();

export function bad(code: string, message: string, hint?: string): ServiceError {
  return new ServiceError(400, code, message, hint);
}

export function isObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Credits are kept to the cent (`numeric(14,2)`). */
export const cents = (n: number): number => Math.round(n * 100) / 100;
export const floorCents = (n: number): number => Math.floor(n * 100 + 1e-9) / 100;

/** "12", "12.5", "12.25" — numbers as people read them in a sentence. */
export const fmt = (n: number): string => String(cents(n));

/** A session for this pod's members (pod claim must equal the pod DID). */
export function requireMember(ctx: GatewayContext, req: RouteRequest): SessionClaims {
  if (!req.session || !req.session.subject) {
    throw new ServiceError(401, 'UNAUTHENTICATED', 'You need to present your passport before doing this.');
  }
  if (req.session.pod !== ctx.podDid) {
    throw new ServiceError(403, 'POD_MISMATCH', 'Your session is not a membership session for this pod.');
  }
  return req.session;
}

export function requireAuthorityIn(ctx: GatewayContext, req: RouteRequest, action: string): SessionClaims {
  const s = requireMember(ctx, req);
  if (!s.authorities.includes(action)) {
    throw new ServiceError(403, 'MISSING_AUTHORITY', `This needs the "${action}" authority, which your passport does not carry.`);
  }
  return s;
}

export function sessionTier(s: SessionClaims): Tier {
  return typeof s.tier === 'string' && (TIERS as readonly string[]).includes(s.tier) ? (s.tier as Tier) : 'T0';
}

export const atLeast = (s: SessionClaims, min: Tier): boolean => tierRank(sessionTier(s)) >= tierRank(min);

/** A sortable, TID-shaped id (base32, microsecond clock + random tie-breaker). */
const B32 = '234567abcdefghijklmnopqrstuvwxyz';
let lastMicros = 0n;
export function tid(now: () => Date): string {
  let micros = BigInt(now().getTime()) * 1000n;
  if (micros <= lastMicros) micros = lastMicros + 1n;
  lastMicros = micros;
  let value = ((micros << 10n) | BigInt(Math.floor(Math.random() * 1024))) & 0x7fffffffffffffffn;
  let out = '';
  for (let i = 0; i < 13; i++) {
    out = B32[Number(value & 0x1fn)] + out;
    value >>= 5n;
  }
  return out;
}

export const optString = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
