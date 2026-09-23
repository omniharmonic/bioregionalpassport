/** `GET /places/resolve` — resolve a lat/lon to a watershed place id (MVP plan §5 Task 10). */
import { ServiceError, type PodContext } from './kit.js';
import { pointInBbox, boundsToBbox } from './geo.js';

export interface ResolvedPlace {
  placeId: string;
  name: string;
  source: 'twin' | 'static';
}

export interface ResolvePlaceDeps {
  /**
   * Injected async resolver wired to the Bioregional Twin MCP's
   * `resolve_point` tool by `apps/web`; not implemented here. Falls back to
   * the static resolver when absent or when it throws.
   */
  twinResolve?: (lat: number, lon: number) => Promise<ResolvedPlace>;
}

function staticResolve(ctx: PodContext, lat: number, lon: number): ResolvedPlace {
  const bbox = boundsToBbox(ctx.manifest.place.bounds);
  if (!pointInBbox(lat, lon, bbox)) {
    throw new ServiceError(404, 'OUT_OF_BOUNDS', 'That point is outside this bioregion.');
  }
  const huc = ctx.manifest.place.watershedSource.hucs?.[0] ?? 'unknown';
  return {
    placeId: `huc12:${huc}`,
    name: `${ctx.manifest.identity.name} watershed`,
    source: 'static',
  };
}

export async function resolvePlace(
  ctx: PodContext,
  lat: number,
  lon: number,
  deps: ResolvePlaceDeps = {},
): Promise<ResolvedPlace> {
  if (ctx.manifest.place.watershedSource.type === 'twin' && deps.twinResolve) {
    try {
      return await deps.twinResolve(lat, lon);
    } catch {
      // Fall through to the static resolver.
    }
  }
  return staticResolve(ctx, lat, lon);
}
