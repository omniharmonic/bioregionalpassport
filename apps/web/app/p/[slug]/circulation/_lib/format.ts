/**
 * Pure helpers for the circulation pages (no React, no server imports) — amounts, identifiers and the
 * Merchant Mode ring-up math. Shared by the member, merchant and steward screens.
 */

/** Rounds down to the cent, as the gateway does (`floorCents`). */
export const floorCents = (n: number): number => Math.floor(n * 100 + 1e-9) / 100;
export const roundCents = (n: number): number => Math.round(n * 100) / 100;

const numberFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const dollarFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

/** The manifest's unit in plural form when needed: "credit" → "credits". */
export function unitLabel(unit: string, value: number): string {
  const u = unit.trim() || 'credit';
  if (Math.abs(value) === 1) return u;
  return /s$/i.test(u) ? u : `${u}s`;
}

/** "12 credits", "1 credit", "12.5 credits". */
export function formatCredits(value: number, unit = 'credit'): string {
  return `${numberFmt.format(value)} ${unitLabel(unit, value)}`;
}

/** Signed form for statements: "+12 credits" / "−12 credits". */
export function formatSignedCredits(value: number, direction: 'in' | 'out', unit = 'credit'): string {
  return `${direction === 'in' ? '+' : '−'}${formatCredits(Math.abs(value), unit)}`;
}

/** "$40.00". */
export function formatDollars(value: number): string {
  return dollarFmt.format(value);
}

/** "did:key:z6Mk…9xQ2" — enough to tell neighbors apart without a wall of characters. */
export function abbreviateDid(did: string | null | undefined): string {
  if (!did) return 'unknown';
  if (did.length <= 24) return did;
  const lastColon = did.lastIndexOf(':');
  const prefix = did.slice(0, lastColon + 1);
  const id = did.slice(lastColon + 1);
  return id.length <= 12 ? did : `${prefix}${id.slice(0, 6)}…${id.slice(-4)}`;
}

/** Share as a whole percent: 0.2 → "20%". */
export const formatShare = (share: number): string => `${Math.round(share * 1000) / 10}%`;

export interface RingUpInput {
  /** Total sale in dollars. */
  totalSale: number;
  /** The enterprise's maximum credit share (0..1). */
  maxShare: number;
  /** Acceptance ceiling (credits). */
  ceiling: number;
  /** The enterprise account's current balance (credits). */
  balance: number;
}

export interface RingUp {
  /** total × maxShare, to the cent (down). */
  shareCap: number;
  /** How many more credits the enterprise can take before its ceiling. */
  headroom: number;
  /** Proposed credit = min(total × maxShare, headroom), never below zero. */
  proposed: number;
  /** Dollars the customer pays on the merchant's usual rails. */
  dollarsDue: number;
}

/** The ring-up screen's proposal, mirroring the gateway's `/pay/request` rule. */
export function ringUp({ totalSale, maxShare, ceiling, balance }: RingUpInput): RingUp {
  const total = Number.isFinite(totalSale) && totalSale > 0 ? roundCents(totalSale) : 0;
  const shareCap = floorCents(total * Math.max(0, Math.min(1, maxShare)));
  const headroom = Math.max(0, floorCents(ceiling - balance));
  const proposed = Math.max(0, floorCents(Math.min(shareCap, headroom)));
  return { shareCap, headroom, proposed, dollarsDue: roundCents(Math.max(0, total - proposed)) };
}

/**
 * Clamps an edited credit amount to what the gateway will accept: above zero, at most the proposal
 * (share cap and ceiling headroom), to the cent.
 */
export function clampCredit(edited: number, r: RingUp): number {
  if (!Number.isFinite(edited) || edited <= 0) return 0;
  return floorCents(Math.min(edited, r.proposed));
}

export type Band = 'ok' | 'warm' | 'hot';
/** Exposure colour band for a share of the ceiling used (0..1+): hot above 80% (the kill line), warm from 50%. */
export function exposureBand(pct: number): Band {
  if (pct > 0.8) return 'hot';
  if (pct >= 0.5) return 'warm';
  return 'ok';
}

/** Seconds left until `expires` (ISO), never negative. */
export function secondsLeft(expires: string, now: number = Date.now()): number {
  const t = Date.parse(expires);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((t - now) / 1000));
}

export const formatCountdown = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** base64url of a UTF-8 string (browser and Node). */
export function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
