import { describe, expect, it } from 'vitest';
import { anchorFor, mergeGatherings, type EventRecordRow, type VtaEventRow } from './merge';

const NOW = new Date('2026-09-23T12:00:00.000Z');

const vta = (over: Partial<VtaEventRow> = {}): VtaEventRow => ({
  id: 'evt_1',
  title: 'E2E verification gathering',
  starts_at: '2026-09-24T16:00:00.000Z',
  ends_at: null,
  place_id: null,
  conveners: ['did:key:a'],
  attestation: true,
  ...over,
});

const rec = (uri: string, record: Record<string, unknown>): EventRecordRow => ({ uri, record });

describe('mergeGatherings', () => {
  it('lists seeded open-record events alongside pod events, sorted by start', () => {
    const out = mergeGatherings(
      [vta()],
      [
        rec('at://boulder/org.bioregion.event/3abc', {
          title: 'Boulder Creek Cleanup + Attestation',
          description: 'Bring gloves; we witness new members at the end.',
          startsAt: '2026-09-26T16:00:00.000Z',
          attestation: true,
          conveners: ['did:web:x'],
          lat: 40.017,
          lon: -105.276,
          location: { name: 'Central Park', lat: 40.017, lon: -105.276 },
        }),
        rec('at://boulder/org.bioregion.event/3abd', { title: 'Neighbor Potluck', startsAt: '2026-09-25T00:00:00.000Z', attestation: false }),
      ],
      NOW,
    );
    expect(out.map((g) => g.title)).toEqual(['E2E verification gathering', 'Neighbor Potluck', 'Boulder Creek Cleanup + Attestation']);
    const cleanup = out[2]!;
    expect(cleanup).toMatchObject({ mappable: true, attestation: true, location: 'Central Park', description: 'Bring gloves; we witness new members at the end.', sources: ['record'] });
    expect(cleanup.key).toBe('rec-3abc');
  });

  it('de-duplicates by title and start, keeping the pod event and the record details', () => {
    const out = mergeGatherings(
      [vta({ title: 'Creek cleanup' })],
      [rec('at://b/org.bioregion.event/9', { title: ' creek CLEANUP ', startsAt: '2026-09-24T16:00:00.000Z', description: 'Gloves.', location: { name: 'Central Park' } })],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: 'evt-evt_1', attestation: true, description: 'Gloves.', location: 'Central Park', sources: ['vta', 'record'] });
  });

  it('drops gatherings that ended more than a day ago and keeps undated ones last', () => {
    const out = mergeGatherings(
      [vta({ id: 'old', title: 'Old', starts_at: '2026-09-01T00:00:00.000Z' }), vta({ id: 'tba', title: 'Undated', starts_at: null })],
      [rec('at://b/org.bioregion.event/1', { title: 'Soon', startsAt: '2026-09-23T18:00:00.000Z' })],
      NOW,
    );
    expect(out.map((g) => g.title)).toEqual(['Soon', 'Undated']);
  });

  it('skips records without a title', () => {
    expect(mergeGatherings([], [rec('at://b/org.bioregion.event/1', { startsAt: '2026-09-24T00:00:00.000Z' })], NOW)).toEqual([]);
  });

  it('makes element-safe anchors from record URIs', () => {
    expect(anchorFor('at://boulder/org.bioregion.enterprise/3k2j-x')).toBe('rec-3k2j-x');
  });
});
