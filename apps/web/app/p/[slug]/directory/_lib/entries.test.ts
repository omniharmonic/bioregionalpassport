import { describe, expect, it } from 'vitest';
import { categoriesOf, parseDirectoryQuery, toCard } from './entries';

describe('directory entries', () => {
  it('parses the search form', () => {
    expect(parseDirectoryQuery({ q: '  bread ', category: ['bakery', 'x'], credits: '1' })).toEqual({ q: 'bread', category: 'bakery', credits: true });
    expect(parseDirectoryQuery({})).toEqual({ q: '', category: '', credits: false });
  });

  it('shapes a seeded enterprise into a card', () => {
    const card = toCard({
      uri: 'at://boulder/org.bioregion.enterprise/3abc',
      record: { name: 'Sourdough & Rye Bakery', categories: ['bakery', 'food'], acceptsLocalCredit: true, acceptanceShare: 0.2, description: 'Bread.', lat: 40, lon: -105, address: '1738 Pearl St' },
      offerCount: 2,
      needCount: 1,
    });
    expect(card).toMatchObject({ anchor: 'rec-3abc', name: 'Sourdough & Rye Bakery', categories: ['bakery', 'food'], acceptsCredits: true, acceptanceShare: 0.2, mappable: true, offerCount: 2, needCount: 1 });
  });

  it('collects categories across enterprises', () => {
    expect(categoriesOf([{ record: { categories: ['food', 'bakery'] } }, { record: { categories: ['food'] } }, { record: {} }])).toEqual(['bakery', 'food']);
  });
});
