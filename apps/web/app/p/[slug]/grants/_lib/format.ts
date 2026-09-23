/** Small display helpers shared by the grants pages (server and client). */

export function money(amount: number, unit: string | null): string {
  const n = Number.isInteger(amount) ? amount.toLocaleString('en-US') : amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return unit ? `${n} ${unit}` : n;
}

export function day(iso: string | null): string {
  if (!iso) return 'To be announced';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export type RoundPhase = 'open' | 'upcoming' | 'counting' | 'published';

/** Which list a round appears in: drafts and not-yet-opened rounds are upcoming; tallying is being counted. */
export function phaseOf(r: { status: string; opensAt: string | null }, now = Date.now()): RoundPhase {
  if (r.status === 'published') return 'published';
  if (r.status === 'tallying') return 'counting';
  if (r.status === 'open' && !(r.opensAt && Date.parse(r.opensAt) > now)) return 'open';
  return 'upcoming';
}

export const PHASE_LABEL: Record<RoundPhase, string> = {
  open: 'Open for voting',
  upcoming: 'Upcoming',
  counting: 'Being counted',
  published: 'Published',
};
