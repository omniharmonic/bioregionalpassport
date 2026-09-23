/** `GET /map` — GeoJSON FeatureCollection of geolocated open records (MVP plan §5 Task 10). */
import type { PodContext } from './kit.js';
import { type Bbox, boundsToBbox } from './geo.js';
import { mapRecordsRow, type RecordRow } from './records.js';

const MAP_COLLECTIONS = ['enterprise', 'event', 'place'] as const;

export interface GeoJsonFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, unknown>;
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

function propertiesFor(row: RecordRow): Record<string, unknown> {
  const r = row.record;
  const props: Record<string, unknown> = { uri: row.uri, collection: row.collection };
  if (row.placeId !== undefined) props.placeId = row.placeId;
  if (row.collection === 'enterprise') {
    props.name = r.name;
    if (r.categories !== undefined) props.categories = r.categories;
    if (r.acceptsLocalCredit !== undefined) props.acceptsLocalCredit = r.acceptsLocalCredit;
  } else if (row.collection === 'event') {
    props.title = r.title;
    if (r.startsAt !== undefined) props.startsAt = r.startsAt;
  } else if (row.collection === 'place') {
    props.name = r.name;
  }
  return props;
}

/** Lists geolocated `enterprise`/`event`/`place` records inside `bbox` as GeoJSON. */
export async function listMapFeatures(ctx: PodContext, bbox: Bbox): Promise<GeoJsonFeatureCollection> {
  const rows = await ctx.db.query(
    `SELECT uri, collection, bioregion, place_id, author_did, record, created_at, updated_at
       FROM records
      WHERE collection = ANY($1)
        AND record ->> 'lat' IS NOT NULL
        AND record ->> 'lon' IS NOT NULL
        AND (record ->> 'lon')::float8 BETWEEN $2 AND $3
        AND (record ->> 'lat')::float8 BETWEEN $4 AND $5
      ORDER BY uri ASC`,
    [MAP_COLLECTIONS, bbox.minLon, bbox.maxLon, bbox.minLat, bbox.maxLat],
  );

  const features: GeoJsonFeature[] = rows.map((row: any) => {
    const mapped = mapRecordsRow(row);
    const lon = Number(mapped.record.lon);
    const lat = Number(mapped.record.lat);
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: propertiesFor(mapped),
    };
  });

  return { type: 'FeatureCollection', features };
}

/** Resolves the effective bbox for `/map`: the query param, or `manifest.place.bounds`. */
export function effectiveBbox(ctx: PodContext, bbox: Bbox | undefined): Bbox {
  return bbox ?? boundsToBbox(ctx.manifest.place.bounds);
}
