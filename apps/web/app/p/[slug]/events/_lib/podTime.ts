/**
 * Dates on pod pages are shown in the pod's own time zone, not the server's (UTC on Vercel) and not the
 * reader's: a gathering at 10:00 in Boulder reads "10:00 AM MDT" wherever the page is rendered.
 *
 * The manifest has no time-zone field yet (`BioregionManifest.place` carries bounds only), so this reads an
 * optional `place.timeZone` / `place.timezone` string when a future manifest adds one and otherwise falls back to
 * `America/Denver`, the zone of both current pods (Boulder and tenant-zero, Front Range).
 */
import type { BioregionManifest } from '@passport/tenant-config';

export const DEFAULT_POD_TIME_ZONE = 'America/Denver';

function validZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The IANA time zone pod dates are shown in. */
export function podTimeZone(manifest: Pick<BioregionManifest, 'place'> | null | undefined): string {
  const place = (manifest?.place ?? {}) as Record<string, unknown>;
  const tz = place['timeZone'] ?? place['timezone'];
  return validZone(tz) ? tz : DEFAULT_POD_TIME_ZONE;
}

const toDate = (v: string | Date): Date => (v instanceof Date ? v : new Date(v));

/** "Sep 22, 2026" in the pod's zone; "To be announced" for no date. */
export function podDay(value: string | Date | null | undefined, timeZone: string): string {
  if (value === null || value === undefined || value === '') return 'To be announced';
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return 'To be announced';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone });
}

/** "Sat, Sep 26, 2026, 10:00 AM MDT" in the pod's zone; "To be announced" for no date. */
export function podDateTime(value: string | Date | null | undefined, timeZone: string): string {
  if (value === null || value === undefined || value === '') return 'To be announced';
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return 'To be announced';
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  });
}
