import { ServiceError } from '@passport/service-kit';

export function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Parses a JSON column that a driver may hand back as a string. */
export function json<T = any>(v: unknown): T {
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

export const bad = (code: string, message: string, hint?: string): ServiceError => new ServiceError(400, code, message, hint);

export function isObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export const day = (iso: string): string => iso.slice(0, 10);
