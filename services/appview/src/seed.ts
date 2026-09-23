/**
 * `seedDemoRecords(ctx)` — idempotent demo data for the map/directory/search UI
 * (MVP plan §5 Task 10). Skips entirely if this pod already has any open
 * record. Every seeded record's author is the pod itself (`ctx.podDid`).
 */
import { RECORD_SCHEMAS, recordUri, type Collection } from '@passport/lexicons';
import type { PodContext } from './kit.js';
import { generateTid } from './tid.js';
import { hasAnyRecords } from './records.js';

function nextSaturdayAt10(from: Date): Date {
  const result = new Date(from);
  const daysUntilSaturday = (6 - result.getDay() + 7) % 7;
  result.setDate(result.getDate() + (daysUntilSaturday === 0 ? 7 : daysUntilSaturday));
  result.setHours(10, 0, 0, 0);
  return result;
}

async function seedRecord(
  ctx: PodContext,
  collection: Collection,
  data: Record<string, unknown>,
): Promise<string> {
  const schema = RECORD_SCHEMAS[collection];
  const parsed = schema.parse({ ...data, bioregion: ctx.slug });
  const rkey = generateTid(ctx.now);
  const uri = recordUri(ctx.slug, collection, rkey);
  const placeId = typeof (parsed as any).placeId === 'string' ? (parsed as any).placeId : null;
  await ctx.db.query(
    `INSERT INTO records (uri, collection, bioregion, place_id, author_did, record, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now(), now())`,
    [uri, collection, ctx.slug, placeId, ctx.podDid, JSON.stringify(parsed)],
  );
  return uri;
}

async function seedFlow(
  ctx: PodContext,
  kind: 'offer' | 'need',
  data: Record<string, unknown>,
): Promise<void> {
  const schema = RECORD_SCHEMAS[kind];
  const parsed = schema.parse({ ...data, bioregion: ctx.slug }) as Record<string, unknown>;
  const rkey = generateTid(ctx.now);
  const enterpriseDid = typeof parsed.enterprise === 'string' ? parsed.enterprise : null;
  await ctx.db.query(
    `INSERT INTO offers (id, enterprise_did, kind, record) VALUES ($1, $2, $3, $4::jsonb)`,
    [rkey, enterpriseDid, kind, JSON.stringify({ ...parsed, authorDid: ctx.podDid })],
  );
}

interface EnterpriseSeed {
  name: string;
  categories: string[];
  acceptsLocalCredit: boolean;
  acceptanceClass: 'services' | 'suppliers' | 'retail';
  description: string;
  lat: number;
  lon: number;
  address: string;
}

const BOULDER_ENTERPRISES: EnterpriseSeed[] = [
  {
    name: 'Kinnikinnick Farm Stand',
    categories: ['farm stand', 'produce'],
    acceptsLocalCredit: true,
    acceptanceClass: 'suppliers',
    description: 'Seasonal produce from a family farm north of town.',
    lat: 40.055,
    lon: -105.24,
    address: '4790 N Broadway, Boulder, CO',
  },
  {
    name: 'Sourdough & Rye Bakery',
    categories: ['bakery', 'food'],
    acceptsLocalCredit: true,
    acceptanceClass: 'suppliers',
    description: 'Wood-fired sourdough and pastries baked daily.',
    lat: 40.018,
    lon: -105.283,
    address: '1738 Pearl St, Boulder, CO',
  },
  {
    name: 'Flatiron Bike Repair',
    categories: ['bike repair', 'service'],
    acceptsLocalCredit: true,
    acceptanceClass: 'services',
    description: 'Tune-ups, flats, and commuter builds.',
    lat: 40.011,
    lon: -105.271,
    address: '2500 30th St, Boulder, CO',
  },
  {
    name: 'Trailhead Bookshop',
    categories: ['bookshop', 'retail'],
    acceptsLocalCredit: true,
    acceptanceClass: 'retail',
    description: 'Used and new books, strong on regional ecology.',
    lat: 40.016,
    lon: -105.278,
    address: '1206 Pearl St, Boulder, CO',
  },
  {
    name: 'Chautauqua Childcare Co-op',
    categories: ['childcare co-op', 'care'],
    acceptsLocalCredit: true,
    acceptanceClass: 'services',
    description: 'Parent-run co-op childcare near the base of the Flatirons.',
    lat: 39.999,
    lon: -105.282,
    address: '900 Baseline Rd, Boulder, CO',
  },
  {
    name: 'Pearl Street Acupuncture',
    categories: ['acupuncture', 'wellness'],
    acceptsLocalCredit: true,
    acceptanceClass: 'services',
    description: 'Community-style acupuncture on a sliding scale.',
    lat: 40.019,
    lon: -105.281,
    address: '1444 Pearl St, Boulder, CO',
  },
  {
    name: 'Boulder Creek Print Shop',
    categories: ['print shop', 'printing'],
    acceptsLocalCredit: false,
    acceptanceClass: 'retail',
    description: 'Risograph and letterpress printing for local makers.',
    lat: 40.014,
    lon: -105.269,
    address: '1650 38th St, Boulder, CO',
  },
  {
    name: 'Chautauqua Tool Library',
    categories: ['tool library', 'tools'],
    acceptsLocalCredit: false,
    acceptanceClass: 'retail',
    description: 'Borrow tools instead of buying them.',
    lat: 40.001,
    lon: -105.285,
    address: '840 Baseline Rd, Boulder, CO',
  },
];

async function seedBoulder(ctx: PodContext): Promise<void> {
  const defaultAcceptance = ctx.manifest.currency.defaultAcceptance;
  const enterpriseUris: string[] = [];
  for (const e of BOULDER_ENTERPRISES) {
    const uri = await seedRecord(ctx, 'enterprise', {
      name: e.name,
      categories: e.categories,
      acceptsLocalCredit: e.acceptsLocalCredit,
      acceptanceShare: defaultAcceptance[e.acceptanceClass],
      stewardDids: [ctx.podDid],
      description: e.description,
      lat: e.lat,
      lon: e.lon,
      address: e.address,
    });
    enterpriseUris.push(uri);
  }

  const saturday = nextSaturdayAt10(ctx.now()).toISOString();
  await seedRecord(ctx, 'event', {
    title: 'Boulder Creek Cleanup + Attestation',
    description: 'Bring gloves; we witness new members at the end.',
    startsAt: saturday,
    attestation: true,
    conveners: [ctx.podDid],
    lat: 40.017,
    lon: -105.276,
    location: { name: 'Central Park', lat: 40.017, lon: -105.276 },
  });
  await seedRecord(ctx, 'event', {
    title: 'Neighbor Potluck',
    description: 'Bring a dish, meet your neighbors.',
    startsAt: new Date(ctx.now().getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    attestation: false,
    conveners: [ctx.podDid],
    lat: 40.005,
    lon: -105.29,
    location: { name: 'Martin Park', lat: 40.005, lon: -105.29 },
  });
  await seedRecord(ctx, 'event', {
    title: 'Repair Café',
    description: 'Bring broken things; leave with fixed things.',
    startsAt: new Date(ctx.now().getTime() + 21 * 24 * 60 * 60 * 1000).toISOString(),
    attestation: false,
    conveners: [ctx.podDid],
    lat: 40.012,
    lon: -105.273,
    location: { name: 'North Boulder Rec Center', lat: 40.012, lon: -105.273 },
  });

  await seedRecord(ctx, 'group', {
    name: 'Boulder Mutual Aid',
    description: 'Neighbor-to-neighbor support network.',
    did: 'did:web:boulder.bioregionalpassport.org:groups:mutual-aid',
    contact: 'mutualaid@boulder.bioregionalpassport.org',
  });
  await seedRecord(ctx, 'group', {
    name: 'South Platte Headwaters Watershed Group',
    description: 'Volunteer stewardship of local creeks and trails.',
    did: 'did:web:boulder.bioregionalpassport.org:groups:watershed',
    contact: 'watershed@boulder.bioregionalpassport.org',
  });

  await seedFlow(ctx, 'offer', {
    resourceSpec: 'Sourdough loaf',
    quantity: { unit: 'loaf', value: 10 },
    availability: 'weekly',
    enterprise: enterpriseUris[1],
    description: 'Ten loaves available every Saturday.',
  });
  await seedFlow(ctx, 'offer', {
    resourceSpec: 'Bike tune-up',
    quantity: { unit: 'session', value: 5 },
    availability: 'by appointment',
    enterprise: enterpriseUris[2],
    description: 'Five tune-up slots a week.',
  });
  await seedFlow(ctx, 'offer', {
    resourceSpec: 'Tool loan',
    quantity: { unit: 'item', value: 40 },
    availability: 'daily',
    enterprise: enterpriseUris[7],
    description: 'Forty tools available to borrow.',
  });
  await seedFlow(ctx, 'need', {
    resourceSpec: 'Volunteer childcare hours',
    quantity: { unit: 'hour', value: 20 },
    availability: 'weekdays',
    enterprise: enterpriseUris[4],
    description: 'Looking for twenty volunteer hours a week.',
  });
  await seedFlow(ctx, 'need', {
    resourceSpec: 'Compostable packaging',
    quantity: { unit: 'unit', value: 200 },
    availability: 'monthly',
    enterprise: enterpriseUris[0],
    description: 'Two hundred units a month for market bags.',
  });
}

async function seedTenantZero(ctx: PodContext): Promise<void> {
  await seedRecord(ctx, 'enterprise', {
    name: 'Tenant Zero General Store',
    categories: ['retail'],
    acceptsLocalCredit: true,
    acceptanceShare: ctx.manifest.currency.defaultAcceptance.retail,
    stewardDids: [ctx.podDid],
    description: 'Reference enterprise for the tenant-zero smoke test.',
    lat: 40.25,
    lon: -105.1,
    address: 'Tenant Zero',
  });
  await seedRecord(ctx, 'enterprise', {
    name: 'Tenant Zero Repair Bench',
    categories: ['service'],
    acceptsLocalCredit: true,
    acceptanceShare: ctx.manifest.currency.defaultAcceptance.services,
    stewardDids: [ctx.podDid],
    description: 'Second reference enterprise for the tenant-zero smoke test.',
    lat: 40.26,
    lon: -105.05,
    address: 'Tenant Zero',
  });

  const saturday = nextSaturdayAt10(ctx.now()).toISOString();
  await seedRecord(ctx, 'event', {
    title: 'Tenant Zero Attestation Event',
    description: 'Smoke-test attestation event.',
    startsAt: saturday,
    attestation: true,
    conveners: [ctx.podDid],
    lat: 40.25,
    lon: -105.08,
    location: { name: 'Tenant Zero Commons', lat: 40.25, lon: -105.08 },
  });

  await seedRecord(ctx, 'group', {
    name: 'Tenant Zero Stewards',
    description: 'Reference group for the tenant-zero smoke test.',
    did: 'did:web:tenant-zero.bioregionalpassport.org:groups:stewards',
    contact: 'stewards@tenant-zero.bioregionalpassport.org',
  });
}

async function seedDefault(ctx: PodContext): Promise<void> {
  const bounds = ctx.manifest.place.bounds;
  const centerLon = (bounds[0][0] + bounds[1][0]) / 2;
  const centerLat = (bounds[0][1] + bounds[1][1]) / 2;

  await seedRecord(ctx, 'enterprise', {
    name: `${ctx.manifest.identity.name} Commons Shop`,
    categories: ['retail'],
    acceptsLocalCredit: true,
    acceptanceShare: ctx.manifest.currency.defaultAcceptance.retail,
    stewardDids: [ctx.podDid],
    description: 'Placeholder enterprise seeded for this bioregion.',
    lat: centerLat,
    lon: centerLon,
    address: ctx.manifest.identity.name,
  });

  const saturday = nextSaturdayAt10(ctx.now()).toISOString();
  await seedRecord(ctx, 'event', {
    title: `${ctx.manifest.identity.name} Attestation Gathering`,
    description: 'Placeholder attestation event seeded for this bioregion.',
    startsAt: saturday,
    attestation: true,
    conveners: [ctx.podDid],
    lat: centerLat,
    lon: centerLon,
    location: { name: `${ctx.manifest.identity.name} Commons`, lat: centerLat, lon: centerLon },
  });
}

/**
 * Seeds demo open records for this pod. No-op if the pod already has any
 * open record (checked via `hasAnyRecords`), so it's safe to call on every
 * provision run.
 */
export async function seedDemoRecords(ctx: PodContext): Promise<void> {
  if (await hasAnyRecords(ctx)) return;

  if (ctx.slug === 'boulder') {
    await seedBoulder(ctx);
  } else if (ctx.slug === 'tenant-zero') {
    await seedTenantZero(ctx);
  } else {
    await seedDefault(ctx);
  }
}
