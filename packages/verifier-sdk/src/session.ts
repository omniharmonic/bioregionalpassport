import { base64urlnopad } from '@scure/base';
import type { VerifyResult } from './verify.js';

/** Claims carried by a gate session token. */
export interface SessionClaims {
  subject: string;
  pod?: string;
  tier?: string;
  authorities: string[];
  delegatedFor?: string;
  /** Issued-at and expiry, seconds since the epoch. */
  iat: number;
  exp: number;
}

interface Payload {
  sub: string;
  pod?: string;
  tier?: string;
  authorities: string[];
  delegatedFor?: string;
  iat: number;
  exp: number;
}

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;
const enc = new TextEncoder();
const dec = new TextDecoder();

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto (crypto.subtle) is not available in this runtime.');
  return s;
}

const MIN_SECRET_BYTES = 32;

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || enc.encode(secret).length < MIN_SECRET_BYTES) {
    throw new Error(`The session secret must be at least ${MIN_SECRET_BYTES} bytes.`);
  }
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await subtle().importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', key, enc.encode(data)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const b64json = (o: unknown) => base64urlnopad.encode(enc.encode(JSON.stringify(o)));

/**
 * Compact HMAC-SHA-256 token `base64url(header).base64url(payload).base64url(sig)` (JWT HS256 shape) for a
 * successful verification. Browser-safe (WebCrypto). Throws if `result.ok` is false or the secret is shorter
 * than 32 bytes.
 */
export async function createSession(result: VerifyResult, secret: string, ttlSec = 3600, now: Date = new Date()): Promise<string> {
  assertSecret(secret);
  if (!result.ok || !result.subject) throw new Error('Only a successful verification can open a session.');
  if (!(ttlSec > 0)) throw new Error('Session lifetime must be positive.');
  const iat = Math.floor(now.getTime() / 1000);
  const payload: Payload = {
    sub: result.subject,
    ...(result.pod !== undefined ? { pod: result.pod } : {}),
    ...(result.tier !== undefined ? { tier: result.tier } : {}),
    authorities: [...result.authorities],
    ...(result.delegatedFor !== undefined ? { delegatedFor: result.delegatedFor } : {}),
    iat,
    exp: iat + Math.floor(ttlSec),
  };
  const signingInput = `${b64json(HEADER)}.${b64json(payload)}`;
  return `${signingInput}.${base64urlnopad.encode(await hmac(secret, signingInput))}`;
}

/** Verify a session token's HMAC (constant-time) and expiry. Returns its claims, or null. Throws only for a secret shorter than 32 bytes. */
export async function readSession(token: string, secret: string, now: Date = new Date()): Promise<SessionClaims | null> {
  assertSecret(secret);
  try {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    const expected = await hmac(secret, `${h}.${p}`);
    if (!constantTimeEqual(expected, base64urlnopad.decode(s))) return null;
    const header = JSON.parse(dec.decode(base64urlnopad.decode(h)));
    if (header?.alg !== HEADER.alg) return null;
    const payload = JSON.parse(dec.decode(base64urlnopad.decode(p))) as Payload;
    if (typeof payload?.sub !== 'string' || !Array.isArray(payload.authorities)) return null;
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp <= payload.iat) return null;
    if (!payload.authorities.every((a) => typeof a === 'string')) return null;
    if (Math.floor(now.getTime() / 1000) >= payload.exp) return null;
    return {
      subject: payload.sub,
      ...(payload.pod !== undefined ? { pod: payload.pod } : {}),
      ...(payload.tier !== undefined ? { tier: payload.tier } : {}),
      authorities: payload.authorities,
      ...(payload.delegatedFor !== undefined ? { delegatedFor: payload.delegatedFor } : {}),
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}
