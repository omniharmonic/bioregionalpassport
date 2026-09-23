import { describe, expect, it } from 'vitest';
import { abbreviateDid, clampCredit, exposureBand, formatCredits, formatDollars, formatSignedCredits, ringUp, secondsLeft, toBase64Url } from './format';

describe('ring-up math', () => {
  it('proposes total × maxShare when the ceiling has room', () => {
    const r = ringUp({ totalSale: 40, maxShare: 0.2, ceiling: 240, balance: 0 });
    expect(r).toEqual({ shareCap: 8, headroom: 240, proposed: 8, dollarsDue: 32 });
  });

  it('clips the proposal to the ceiling headroom', () => {
    const r = ringUp({ totalSale: 100, maxShare: 0.75, ceiling: 240, balance: 230 });
    expect(r.shareCap).toBe(75);
    expect(r.headroom).toBe(10);
    expect(r.proposed).toBe(10);
    expect(r.dollarsDue).toBe(90);
  });

  it('floors to the cent and never goes below zero', () => {
    expect(ringUp({ totalSale: 10.01, maxShare: 0.35, ceiling: 100, balance: 0 }).proposed).toBe(3.5);
    expect(ringUp({ totalSale: 50, maxShare: 0.2, ceiling: 100, balance: 120 }).proposed).toBe(0);
    expect(ringUp({ totalSale: -5, maxShare: 0.2, ceiling: 100, balance: 0 }).proposed).toBe(0);
  });

  it('clamps an edited credit amount to the proposal', () => {
    const r = ringUp({ totalSale: 40, maxShare: 0.2, ceiling: 240, balance: 0 });
    expect(clampCredit(5, r)).toBe(5);
    expect(clampCredit(50, r)).toBe(8);
    expect(clampCredit(-1, r)).toBe(0);
  });
});

describe('formatting', () => {
  it('formats credits with the manifest unit and dollars with cents', () => {
    expect(formatCredits(12)).toBe('12 credits');
    expect(formatCredits(1)).toBe('1 credit');
    expect(formatCredits(12.5, 'hour')).toBe('12.5 hours');
    expect(formatSignedCredits(3, 'out')).toBe('−3 credits');
    expect(formatDollars(40)).toBe('$40.00');
  });

  it('abbreviates long identifiers', () => {
    expect(abbreviateDid('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK')).toBe('did:key:z6Mkha…2doK');
    expect(abbreviateDid('did:key:zShort')).toBe('did:key:zShort');
  });

  it('bands exposure and counts down', () => {
    expect(exposureBand(0.2)).toBe('ok');
    expect(exposureBand(0.6)).toBe('warm');
    expect(exposureBand(0.81)).toBe('hot');
    expect(secondsLeft('2026-09-22T00:10:00Z', Date.parse('2026-09-22T00:00:00Z'))).toBe(600);
    expect(toBase64Url('{"a":"ü"}')).toBe('eyJhIjoiw7wifQ');
  });
});
