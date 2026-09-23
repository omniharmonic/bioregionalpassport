import { describe, expect, it } from 'vitest';
import {
  COLLECTIONS,
  COLLECTION_NSID,
  EnterpriseRecordSchema,
  EventRecordSchema,
  GroupRecordSchema,
  IdentityLinkRecordSchema,
  NeedRecordSchema,
  OfferRecordSchema,
  PlaceRecordSchema,
  PodRecordSchema,
  ProjectRecordSchema,
  RECORD_SCHEMAS,
  parseRecordUri,
  recordUri,
} from './records.js';

describe('PlaceRecordSchema', () => {
  it('accepts a valid place', () => {
    const result = PlaceRecordSchema.safeParse({
      bioregion: 'boulder',
      placeId: 'huc12-101800040103',
      name: 'Boulder Creek',
      lat: 40.015,
      lon: -105.27,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a place missing placeId', () => {
    const result = PlaceRecordSchema.safeParse({
      bioregion: 'boulder',
      name: 'Boulder Creek',
    });
    expect(result.success).toBe(false);
  });
});

describe('EnterpriseRecordSchema', () => {
  it('accepts a valid enterprise', () => {
    const result = EnterpriseRecordSchema.safeParse({
      bioregion: 'boulder',
      name: 'Front Range Fixit Co-op',
      categories: ['repair', 'retail'],
      acceptsLocalCredit: true,
      acceptanceShare: 0.35,
      stewardDids: ['did:key:z6Mkexample'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects acceptanceShare out of 0..1 range', () => {
    const result = EnterpriseRecordSchema.safeParse({
      bioregion: 'boulder',
      name: 'Front Range Fixit Co-op',
      categories: ['repair'],
      acceptsLocalCredit: true,
      acceptanceShare: 1.5,
      stewardDids: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('OfferRecordSchema / NeedRecordSchema', () => {
  it('accepts a valid offer', () => {
    const result = OfferRecordSchema.safeParse({
      bioregion: 'boulder',
      resourceSpec: 'garden labor',
      quantity: { unit: 'hour', value: 2 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an offer missing resourceSpec', () => {
    const result = OfferRecordSchema.safeParse({
      bioregion: 'boulder',
      quantity: { unit: 'hour', value: 2 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid need', () => {
    const result = NeedRecordSchema.safeParse({
      bioregion: 'boulder',
      resourceSpec: 'firewood',
      quantity: { unit: 'cord', value: 1 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a need with a malformed quantity', () => {
    const result = NeedRecordSchema.safeParse({
      bioregion: 'boulder',
      resourceSpec: 'firewood',
      quantity: { unit: 'cord' },
    });
    expect(result.success).toBe(false);
  });
});

describe('EventRecordSchema', () => {
  it('accepts a valid event', () => {
    const result = EventRecordSchema.safeParse({
      bioregion: 'boulder',
      title: 'Fall gathering',
      startsAt: '2026-10-01T18:00:00Z',
      attestation: true,
      conveners: ['did:key:z6Mkconvener'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an event missing attestation', () => {
    const result = EventRecordSchema.safeParse({
      bioregion: 'boulder',
      title: 'Fall gathering',
      startsAt: '2026-10-01T18:00:00Z',
      conveners: ['did:key:z6Mkconvener'],
    });
    expect(result.success).toBe(false);
  });
});

describe('GroupRecordSchema', () => {
  it('accepts a valid group', () => {
    const result = GroupRecordSchema.safeParse({
      bioregion: 'boulder',
      name: 'Watershed Stewards',
      did: 'did:web:bioregionalpassport.org:groups:watershed-stewards',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a group missing did', () => {
    const result = GroupRecordSchema.safeParse({
      bioregion: 'boulder',
      name: 'Watershed Stewards',
    });
    expect(result.success).toBe(false);
  });
});

describe('ProjectRecordSchema', () => {
  it('accepts a valid project', () => {
    const result = ProjectRecordSchema.safeParse({
      bioregion: 'boulder',
      title: 'Community compost hub',
      budget: 500,
      funded: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a project with a non-string title', () => {
    const result = ProjectRecordSchema.safeParse({
      bioregion: 'boulder',
      title: 42,
    });
    expect(result.success).toBe(false);
  });
});

describe('IdentityLinkRecordSchema', () => {
  it('accepts a valid identity link', () => {
    const result = IdentityLinkRecordSchema.safeParse({
      bioregion: 'boulder',
      podPersona: 'did:key:z6Mkpersona',
      vpcDigest: 'zQmDigestExample',
      revocable: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects revocable: false (must be literal true)', () => {
    const result = IdentityLinkRecordSchema.safeParse({
      bioregion: 'boulder',
      podPersona: 'did:key:z6Mkpersona',
      vpcDigest: 'zQmDigestExample',
      revocable: false,
    });
    expect(result.success).toBe(false);
  });
});

describe('PodRecordSchema', () => {
  it('accepts a valid pod card', () => {
    const result = PodRecordSchema.safeParse({
      bioregion: 'boulder',
      slug: 'boulder',
      name: 'Boulder Commons',
      did: 'did:web:bioregionalpassport.org:dids:boulder',
      manifestUrl: 'https://boulder.bioregionalpassport.org/.well-known/bioregion.json',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a pod card missing manifestUrl', () => {
    const result = PodRecordSchema.safeParse({
      bioregion: 'boulder',
      slug: 'boulder',
      name: 'Boulder Commons',
      did: 'did:web:bioregionalpassport.org:dids:boulder',
    });
    expect(result.success).toBe(false);
  });
});

describe('RECORD_SCHEMAS / COLLECTION_NSID', () => {
  it('has a schema for every collection', () => {
    for (const collection of COLLECTIONS) {
      expect(RECORD_SCHEMAS[collection]).toBeDefined();
    }
  });

  it('maps identityLink to org.bioregion.identity.link', () => {
    expect(COLLECTION_NSID.identityLink).toBe('org.bioregion.identity.link');
  });

  it('maps every other collection to org.bioregion.<name>', () => {
    for (const collection of COLLECTIONS) {
      if (collection === 'identityLink') continue;
      expect(COLLECTION_NSID[collection]).toBe(`org.bioregion.${collection}`);
    }
  });
});

describe('recordUri / parseRecordUri', () => {
  it('builds an at:// uri', () => {
    expect(recordUri('boulder', 'enterprise', 'abc123')).toBe(
      'at://boulder/org.bioregion.enterprise/abc123',
    );
  });

  it('builds an identityLink uri with the dotted nsid', () => {
    expect(recordUri('boulder', 'identityLink', 'xyz')).toBe(
      'at://boulder/org.bioregion.identity.link/xyz',
    );
  });

  it('round-trips through parseRecordUri', () => {
    const uri = recordUri('tenant-zero', 'event', 'evt-1');
    expect(parseRecordUri(uri)).toEqual({
      slug: 'tenant-zero',
      collection: 'event',
      nsid: 'org.bioregion.event',
      rkey: 'evt-1',
    });
  });

  it('throws on a malformed uri', () => {
    expect(() => parseRecordUri('not-a-uri')).toThrow();
  });

  it('throws on an unknown collection nsid', () => {
    expect(() => parseRecordUri('at://boulder/org.bioregion.mystery/1')).toThrow();
  });
});
