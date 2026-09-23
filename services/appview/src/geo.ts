import { ServiceError } from './kit.js';

/** `[[minLon, minLat], [maxLon, maxLat]]`, the manifest `place.bounds` shape. */
export type Bounds = readonly [readonly [number, number], readonly [number, number]];

export interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export function boundsToBbox(bounds: Bounds): Bbox {
  const [[minLon, minLat], [maxLon, maxLat]] = bounds;
  return { minLon, minLat, maxLon, maxLat };
}

const INVALID_BBOX_MESSAGE =
  'The map bounds must be minLon,minLat,maxLon,maxLat with min less than max.';

/**
 * Parses `?bbox=minLon,minLat,maxLon,maxLat`. Returns `undefined` only when
 * `raw` is absent (callers then fall back to `manifest.place.bounds`); a
 * present-but-malformed value (wrong arity, non-numeric, or inverted/
 * degenerate — min >= max on either axis) throws `ServiceError(400,
 * 'INVALID_BBOX', …)` rather than silently falling back.
 */
export function parseBbox(raw: string | undefined): Bbox | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    throw new ServiceError(400, 'INVALID_BBOX', INVALID_BBOX_MESSAGE);
  }
  const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number];
  if (minLon >= maxLon || minLat >= maxLat) {
    throw new ServiceError(400, 'INVALID_BBOX', INVALID_BBOX_MESSAGE);
  }
  return { minLon, minLat, maxLon, maxLat };
}

export function pointInBbox(lat: number, lon: number, bbox: Bbox): boolean {
  return lon >= bbox.minLon && lon <= bbox.maxLon && lat >= bbox.minLat && lat <= bbox.maxLat;
}
