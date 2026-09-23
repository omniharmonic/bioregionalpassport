import { describe, expect, it } from 'vitest';
import { DEFAULT_POD_TIME_ZONE, podDateTime, podDay, podTimeZone } from './podTime';

describe('pod time zone', () => {
  it('defaults to America/Denver when the manifest names no zone', () => {
    expect(podTimeZone({ place: { bounds: [[0, 0], [1, 1]] } } as never)).toBe(DEFAULT_POD_TIME_ZONE);
    expect(podTimeZone(null)).toBe('America/Denver');
  });

  it('uses a valid place.timeZone and ignores an invalid one', () => {
    expect(podTimeZone({ place: { timeZone: 'Europe/Lisbon' } } as never)).toBe('Europe/Lisbon');
    expect(podTimeZone({ place: { timeZone: 'Not/AZone' } } as never)).toBe('America/Denver');
  });

  it('shows an evening round opening on its local day, not the next UTC day (issue 7)', () => {
    // 2026-09-22 20:00 in Denver (MDT, UTC-6) is 2026-09-23T02:00Z.
    expect(podDay('2026-09-23T02:00:00.000Z', 'America/Denver')).toBe('Sep 22, 2026');
    expect(podDay('2026-09-23T02:00:00.000Z', 'UTC')).toBe('Sep 23, 2026');
  });

  it('formats date and time with the zone name', () => {
    expect(podDateTime('2026-09-26T16:00:00.000Z', 'America/Denver')).toBe('Sat, Sep 26, 2026, 10:00 AM MDT');
    expect(podDateTime(null, 'America/Denver')).toBe('To be announced');
  });
});
