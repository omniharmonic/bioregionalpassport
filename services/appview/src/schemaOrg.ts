/** `GET /schema-org/:type` — schema.org JSON-LD `@graph` export (MVP plan §5 Task 10). */
import { ServiceError, type PodContext } from './kit.js';
import { listRecords } from './records.js';

export type SchemaOrgType = 'enterprise' | 'event' | 'project';

const SCHEMA_ORG_CONTEXT = 'https://schema.org';

function enterpriseToLocalBusiness(uri: string, r: Record<string, unknown>): Record<string, unknown> {
  const node: Record<string, unknown> = {
    '@type': 'LocalBusiness',
    '@id': uri,
    name: r.name,
  };
  if (r.description !== undefined) node.description = r.description;
  if (r.address !== undefined) {
    node.address = { '@type': 'PostalAddress', streetAddress: r.address };
  }
  if (typeof r.lat === 'number' && typeof r.lon === 'number') {
    node.geo = { '@type': 'GeoCoordinates', latitude: r.lat, longitude: r.lon };
  }
  if (r.website !== undefined) node.url = r.website;
  if (Array.isArray(r.categories) && r.categories.length > 0) {
    node.keywords = (r.categories as unknown[]).join(', ');
  }
  if (r.acceptsLocalCredit !== undefined) {
    node.additionalProperty = {
      '@type': 'PropertyValue',
      name: 'acceptsLocalCredit',
      value: r.acceptsLocalCredit,
    };
  }
  return node;
}

function eventToSchemaOrgEvent(uri: string, r: Record<string, unknown>): Record<string, unknown> {
  const node: Record<string, unknown> = {
    '@type': 'Event',
    '@id': uri,
    name: r.title,
    startDate: r.startsAt,
  };
  if (r.endsAt !== undefined) node.endDate = r.endsAt;
  if (typeof r.lat === 'number' && typeof r.lon === 'number') {
    node.location = {
      '@type': 'Place',
      name: (r.location as any)?.name ?? r.title,
      geo: { '@type': 'GeoCoordinates', latitude: r.lat, longitude: r.lon },
    };
  }
  return node;
}

function projectToSchemaOrgProject(
  uri: string,
  r: Record<string, unknown>,
  funderName: string,
): Record<string, unknown> {
  const node: Record<string, unknown> = {
    '@type': 'Project',
    '@id': uri,
    name: r.title,
    funder: { '@type': 'Organization', name: funderName },
  };
  if (r.summary !== undefined) node.description = r.summary;
  if (r.budget !== undefined) node.budget = r.budget;
  return node;
}

/** Builds a JSON-LD `{ "@context", "@graph" }` document for a schema.org type. */
export async function schemaOrgGraph(ctx: PodContext, type: string): Promise<Record<string, unknown>> {
  let graph: Record<string, unknown>[];
  if (type === 'enterprise') {
    const { rows } = await listRecords(ctx, 'enterprise', { limit: 200 });
    graph = rows.map((row) => enterpriseToLocalBusiness(row.uri, row.record));
  } else if (type === 'event') {
    const { rows } = await listRecords(ctx, 'event', { limit: 200 });
    graph = rows.map((row) => eventToSchemaOrgEvent(row.uri, row.record));
  } else if (type === 'project') {
    const { rows } = await listRecords(ctx, 'project', { limit: 200 });
    graph = rows.map((row) => projectToSchemaOrgProject(row.uri, row.record, ctx.manifest.identity.name));
  } else {
    throw new ServiceError(400, 'UNKNOWN_SCHEMA_ORG_TYPE', `"${type}" has no schema.org mapping.`);
  }

  return { '@context': SCHEMA_ORG_CONTEXT, '@graph': graph };
}
