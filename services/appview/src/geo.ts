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

/** Parses `?bbox=minLon,minLat,maxLon,maxLat`; returns `undefined` if absent or malformed. */
export function parseBbox(raw: string | undefined): Bbox | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return undefined;
  const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number];
  return { minLon, minLat, maxLon, maxLat };
}

export function pointInBbox(lat: number, lon: number, bbox: Bbox): boolean {
  return lon >= bbox.minLon && lon <= bbox.maxLon && lat >= bbox.minLat && lat <= bbox.maxLat;
}
