import { ServiceError, type RouteRequest, type SessionClaims } from '@passport/service-kit';
import type { VtaContext } from './types.js';

export const DAY_MS = 86_400_000;

export const addDays = (d: Date, days: number): string => new Date(d.getTime() + days * DAY_MS).toISOString();

export function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const toMs = (v: unknown): number => {
  const s = toIso(v);
  return s ? Date.parse(s) : Number.NaN;
};

/** Parses a JSON column that a driver may hand back as a string. */
export function json<T = any>(v: unknown): T {
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

export function bad(code: string, message: string, hint?: string): ServiceError {
  return new ServiceError(400, code, message, hint);
}

export function isObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A session for this pod's members (pod claim must equal the pod DID; visitor sessions carry no pod). */
export function requireMember(ctx: VtaContext, req: RouteRequest): SessionClaims {
  if (!req.session || !req.session.subject) {
    throw new ServiceError(401, 'UNAUTHENTICATED', 'You need to present your passport before doing this.');
  }
  if (req.session.pod !== ctx.podDid) {
    throw new ServiceError(403, 'POD_MISMATCH', 'Your session is not a membership session for this pod.');
  }
  return req.session;
}

/** Safety margin kept below a B3 validity ceiling so clock drift can never trip a builder's ceiling check. */
export const VALIDITY_SAFETY_MS = 60_000;

/**
 * `{ validFrom, validUntil }` from ONE instant: `min(days, ceilingDays)` days minus one minute of safety.
 * Always use this for grants and VACs so `validUntil − validFrom` stays under the ceiling.
 */
export function validityWindow(now: Date, days: number, ceilingDays: number): { validFrom: string; validUntil: string } {
  const span = Math.min(days, ceilingDays) * DAY_MS - VALIDITY_SAFETY_MS;
  if (!(span > 0)) throw new Error('Validity must be positive.');
  return { validFrom: now.toISOString(), validUntil: new Date(now.getTime() + span).toISOString() };
}
