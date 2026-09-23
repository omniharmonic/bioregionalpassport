/** Pure helpers for the map island (unit-tested; no MapLibre import). */

export const COLLECTIONS = ['enterprise', 'event', 'place'] as const;
export type MapCollection = (typeof COLLECTIONS)[number];

export const COLLECTION_LABEL: Record<MapCollection, string> = {
  enterprise: 'Enterprises',
  event: 'Gatherings',
  place: 'Places',
};

/** Free OpenFreeMap vector style (no key). */
export const VECTOR_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/** Fallback when the vector style cannot load: raster OpenStreetMap tiles, with the required attribution. */
export const RASTER_FALLBACK_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: 'raster' as const,
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster' as const, source: 'osm' }],
};

export interface MapFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, unknown>;
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: MapFeature[];
}

export const isCollection = (v: unknown): v is MapCollection => typeof v === 'string' && (COLLECTIONS as readonly string[]).includes(v);

/** Keeps well-formed point features of the three known collections. */
export function cleanFeatures(input: unknown): MapFeature[] {
  const list = (input as { features?: unknown })?.features;
  if (!Array.isArray(list)) return [];
  return list.filter((f): f is MapFeature => {
    const c = (f as MapFeature)?.geometry?.coordinates;
    return (
      (f as MapFeature)?.type === 'Feature' &&
      Array.isArray(c) &&
      c.length === 2 &&
      Number.isFinite(c[0]) &&
      Number.isFinite(c[1]) &&
      isCollection((f as MapFeature).properties?.['collection']) &&
      typeof (f as MapFeature).properties?.['uri'] === 'string'
    );
  });
}

export interface PopupModel {
  title: string;
  kind: string;
  categories: string[];
  acceptsCredits: boolean;
  when: string | null;
  link: { href: string; label: string } | null;
}

export function anchorFor(uri: string): string {
  const tail = uri.split('/').pop() ?? uri;
  return `rec-${tail.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

/** What a marker's popup shows, and where its link goes (the directory entry or the event). */
export function popupFor(p: Record<string, unknown>, base: string, formatWhen: (iso: string) => string): PopupModel {
  const collection = isCollection(p['collection']) ? p['collection'] : 'place';
  const uri = String(p['uri'] ?? '');
  const title = String((collection === 'event' ? p['title'] : p['name']) ?? 'Untitled');
  const categories = Array.isArray(p['categories']) ? p['categories'].filter((c): c is string => typeof c === 'string') : [];
  const startsAt = typeof p['startsAt'] === 'string' ? p['startsAt'] : null;
  const link =
    collection === 'enterprise'
      ? { href: `${base}/directory#${anchorFor(uri)}`, label: 'Open in the directory' }
      : collection === 'event'
        ? { href: `${base}/events#${anchorFor(uri)}`, label: 'See the gathering' }
        : null;
  return {
    title,
    kind: collection === 'enterprise' ? 'Enterprise' : collection === 'event' ? 'Gathering' : 'Place',
    categories,
    acceptsCredits: p['acceptsLocalCredit'] === true,
    when: startsAt ? formatWhen(startsAt) : null,
    link,
  };
}

/** `[[minLon, minLat], [maxLon, maxLat]]` from the manifest, or null when malformed. */
export function boundsOf(bounds: unknown): [[number, number], [number, number]] | null {
  if (!Array.isArray(bounds) || bounds.length !== 2) return null;
  const [a, b] = bounds as unknown[][];
  const nums = [a?.[0], a?.[1], b?.[0], b?.[1]];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return [
    [a![0] as number, a![1] as number],
    [b![0] as number, b![1] as number],
  ];
}
