/**
 * Open-record lexicons, `org.bioregion.*` (B3 §8).
 *
 * Every record carries `bioregion` (the pod slug) and, where spatial, `placeId`.
 * These are stored in the pod schema and served by `services/appview` for MVP
 * (ADR-24); an ATProto PDS is the migration target.
 */
import { z } from 'zod';
import { bioregion, latitude, longitude, optionalPlaceId, QuantitySchema } from './common.js';

// -- org.bioregion.place ----------------------------------------------------

export const PlaceRecordSchema = z.object({
  bioregion: bioregion(),
  placeId: z.string().min(1),
  name: z.string().min(1),
  geometryRef: z.string().min(1).optional(),
  twinRef: z.string().min(1).optional(),
  lat: latitude().optional(),
  lon: longitude().optional(),
});
export type PlaceRecord = z.infer<typeof PlaceRecordSchema>;

// -- org.bioregion.enterprise -------------------------------------------------

export const EnterpriseRecordSchema = z.object({
  bioregion: bioregion(),
  placeId: optionalPlaceId(),
  name: z.string().min(1),
  categories: z.array(z.string().min(1)),
  acceptsLocalCredit: z.boolean(),
  acceptanceShare: z.number().min(0).max(1),
  stewardDids: z.array(z.string().min(1)),
  did: z.string().min(1).optional(),
  description: z.string().optional(),
  lat: latitude().optional(),
  lon: longitude().optional(),
  address: z.string().optional(),
  website: z.string().optional(),
});
export type EnterpriseRecord = z.infer<typeof EnterpriseRecordSchema>;

// -- org.bioregion.offer / org.bioregion.need (Valueflows) --------------------

const ResourceFlowFields = {
  bioregion: bioregion(),
  placeId: optionalPlaceId(),
  resourceSpec: z.string().min(1),
  quantity: QuantitySchema,
  availability: z.string().optional(),
  enterprise: z.string().min(1).optional(),
  description: z.string().optional(),
};

export const OfferRecordSchema = z.object(ResourceFlowFields);
export type OfferRecord = z.infer<typeof OfferRecordSchema>;

export const NeedRecordSchema = z.object(ResourceFlowFields);
export type NeedRecord = z.infer<typeof NeedRecordSchema>;

// -- org.bioregion.event -------------------------------------------------------

export const EventLocationSchema = z.object({
  placeId: z.string().min(1).optional(),
  lat: latitude().optional(),
  lon: longitude().optional(),
  name: z.string().min(1).optional(),
});
export type EventLocation = z.infer<typeof EventLocationSchema>;

export const EventRecordSchema = z.object({
  bioregion: bioregion(),
  placeId: optionalPlaceId(),
  title: z.string().min(1),
  description: z.string().optional(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  lat: latitude().optional(),
  lon: longitude().optional(),
  attestation: z.boolean(),
  conveners: z.array(z.string().min(1)),
  location: EventLocationSchema.optional(),
});
export type EventRecord = z.infer<typeof EventRecordSchema>;

// -- org.bioregion.group --------------------------------------------------------

export const GroupRecordSchema = z.object({
  bioregion: bioregion(),
  placeId: optionalPlaceId(),
  name: z.string().min(1),
  description: z.string().optional(),
  did: z.string().min(1),
  contact: z.string().optional(),
});
export type GroupRecord = z.infer<typeof GroupRecordSchema>;

// -- org.bioregion.project --------------------------------------------------------

export const ProjectRecordSchema = z.object({
  bioregion: bioregion(),
  placeId: optionalPlaceId(),
  title: z.string().min(1),
  summary: z.string().optional(),
  round: z.string().min(1).optional(),
  budget: z.number().optional(),
  lead: z.string().min(1).optional(),
  funded: z.boolean().optional(),
  tally: z.unknown().optional(),
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

// -- org.bioregion.identity.link ----------------------------------------------

export const IdentityLinkRecordSchema = z.object({
  bioregion: bioregion(),
  placeId: optionalPlaceId(),
  podPersona: z.string().min(1),
  vpcDigest: z.string().min(1),
  revocable: z.literal(true),
});
export type IdentityLinkRecord = z.infer<typeof IdentityLinkRecordSchema>;

// -- org.bioregion.pod ------------------------------------------------------------

export const PodRecordSchema = z.object({
  bioregion: bioregion(),
  placeId: optionalPlaceId(),
  slug: z.string().min(1),
  name: z.string().min(1),
  did: z.string().min(1),
  manifestUrl: z.string().min(1),
  registryEntry: z.string().min(1).optional(),
});
export type PodRecord = z.infer<typeof PodRecordSchema>;

// -- collections --------------------------------------------------------------

/** Short collection names keyed to their `org.bioregion.*` NSID and zod schema. */
export const COLLECTIONS = [
  'place',
  'enterprise',
  'offer',
  'need',
  'event',
  'group',
  'project',
  'identityLink',
  'pod',
] as const;
export type Collection = (typeof COLLECTIONS)[number];

/** `org.bioregion.<name>` NSID for each collection (`identityLink` -> `org.bioregion.identity.link`). */
export const COLLECTION_NSID: Record<Collection, string> = {
  place: 'org.bioregion.place',
  enterprise: 'org.bioregion.enterprise',
  offer: 'org.bioregion.offer',
  need: 'org.bioregion.need',
  event: 'org.bioregion.event',
  group: 'org.bioregion.group',
  project: 'org.bioregion.project',
  identityLink: 'org.bioregion.identity.link',
  pod: 'org.bioregion.pod',
};

const NSID_TO_COLLECTION: Record<string, Collection> = Object.fromEntries(
  (Object.entries(COLLECTION_NSID) as [Collection, string][]).map(([collection, nsid]) => [
    nsid,
    collection,
  ]),
);

/** zod schema for each open-record collection, keyed by its short name. */
export const RECORD_SCHEMAS: Record<Collection, z.ZodType> = {
  place: PlaceRecordSchema,
  enterprise: EnterpriseRecordSchema,
  offer: OfferRecordSchema,
  need: NeedRecordSchema,
  event: EventRecordSchema,
  group: GroupRecordSchema,
  project: ProjectRecordSchema,
  identityLink: IdentityLinkRecordSchema,
  pod: PodRecordSchema,
};

/**
 * Build an `at://` record URI. The slug stands in for the repo DID until a
 * PDS lands (ADR-24): `at://<slug>/org.bioregion.<collection>/<rkey>`.
 */
export function recordUri(slug: string, collection: Collection, rkey: string): string {
  const nsid = COLLECTION_NSID[collection];
  if (!nsid) throw new Error(`unknown collection: ${collection}`);
  return `at://${slug}/${nsid}/${rkey}`;
}

export interface ParsedRecordUri {
  slug: string;
  collection: Collection;
  nsid: string;
  rkey: string;
}

/** Parse an `at://<slug>/org.bioregion.<collection>/<rkey>` record URI. */
export function parseRecordUri(uri: string): ParsedRecordUri {
  const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!match) throw new Error(`invalid record uri: ${uri}`);
  const [, slug, nsid, rkey] = match as unknown as [string, string, string, string];
  const collection = NSID_TO_COLLECTION[nsid];
  if (!collection) throw new Error(`unknown collection nsid in uri: ${nsid}`);
  return { slug, collection, nsid, rkey };
}
