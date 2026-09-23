import { describe, expect, it } from 'vitest';
import { boundsOf, cleanFeatures, popupFor } from './features';

const fc = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-105.283, 40.018] }, properties: { uri: 'at://boulder/org.bioregion.enterprise/3a', collection: 'enterprise', name: 'Sourdough & Rye Bakery', categories: ['bakery'], acceptsLocalCredit: true } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-105.276, 40.017] }, properties: { uri: 'at://boulder/org.bioregion.event/3b', collection: 'event', title: 'Boulder Creek Cleanup + Attestation', startsAt: '2026-09-26T16:00:00.000Z' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: ['x', 40] }, properties: { uri: 'u', collection: 'enterprise' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { uri: 'u', collection: 'offer' } },
  ],
};

describe('map features', () => {
  it('keeps only well-formed features of known collections', () => {
    expect(cleanFeatures(fc).map((f) => f.properties['collection'])).toEqual(['enterprise', 'event']);
    expect(cleanFeatures(null)).toEqual([]);
  });

  it('builds popups that link to the directory entry or the event', () => {
    const [ent, ev] = cleanFeatures(fc);
    expect(popupFor(ent!.properties, '/p/boulder', (s) => s)).toEqual({
      title: 'Sourdough & Rye Bakery',
      kind: 'Enterprise',
      categories: ['bakery'],
      acceptsCredits: true,
      when: null,
      link: { href: '/p/boulder/directory#rec-3a', label: 'Open in the directory' },
    });
    expect(popupFor(ev!.properties, '', () => 'Sat 10 AM')).toMatchObject({ title: 'Boulder Creek Cleanup + Attestation', kind: 'Gathering', when: 'Sat 10 AM', link: { href: '/events#rec-3b' } });
  });

  it('reads manifest bounds', () => {
    expect(boundsOf([[-105.7, 39.9], [-105.1, 40.2]])).toEqual([[-105.7, 39.9], [-105.1, 40.2]]);
    expect(boundsOf([[1, 2]])).toBeNull();
  });
});
