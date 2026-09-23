/** `createAppviewRoutes()` — the AppView's `Route[]` table (MVP plan §5 Task 10, §4.5 handler shape). */
import { ServiceError, requireSession, type Route } from './kit.js';
import { listRecords, getRecord, putRecord, deleteRecord } from './records.js';
import { listMapFeatures, effectiveBbox } from './map.js';
import { parseBbox } from './geo.js';
import { listDirectory } from './directory.js';
import { searchRecords } from './search.js';
import { schemaOrgGraph } from './schemaOrg.js';
import { resolvePlace, type ResolvePlaceDeps } from './places.js';

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return undefined;
}

function requireNumber(raw: string | undefined, name: string): number {
  const n = Number(raw);
  if (raw === undefined || Number.isNaN(n)) {
    throw new ServiceError(400, 'INVALID_QUERY', `"${name}" must be a number.`);
  }
  return n;
}

export interface AppviewDeps extends ResolvePlaceDeps {}

/** Builds the AppView's mountable route table. `apps/web` mounts this under `/api/appview`. */
export function createAppviewRoutes(deps: AppviewDeps = {}): Route[] {
  return [
    {
      method: 'GET',
      path: '/map',
      auth: 'none',
      handler: async (ctx, req) => {
        const bbox = effectiveBbox(ctx, parseBbox(req.query.bbox));
        const featureCollection = await listMapFeatures(ctx, bbox);
        return { body: featureCollection };
      },
    },
    {
      method: 'GET',
      path: '/directory',
      auth: 'none',
      handler: async (ctx, req) => {
        const entries = await listDirectory(ctx, {
          category: req.query.category || undefined,
          q: req.query.q || undefined,
          acceptsLocalCredit: parseBool(req.query.acceptsLocalCredit),
        });
        return { body: { entries } };
      },
    },
    {
      method: 'GET',
      path: '/search',
      auth: 'none',
      handler: async (ctx, req) => {
        const results = await searchRecords(ctx, req.query.q ?? '');
        return { body: { results } };
      },
    },
    {
      method: 'GET',
      path: '/records/:collection',
      auth: 'none',
      handler: async (ctx, req) => {
        const rows = await listRecords(ctx, req.params.collection ?? '', {
          limit: req.query.limit ? Number(req.query.limit) : undefined,
          cursor: req.query.cursor || undefined,
        });
        return { body: { records: rows } };
      },
    },
    {
      method: 'GET',
      path: '/records/:collection/:rkey',
      auth: 'none',
      handler: async (ctx, req) => {
        const row = await getRecord(ctx, req.params.collection ?? '', req.params.rkey ?? '');
        if (!row) {
          throw new ServiceError(404, 'NOT_FOUND', 'No record exists at that key.');
        }
        return { body: row };
      },
    },
    {
      method: 'POST',
      path: '/records/:collection',
      auth: 'member',
      handler: async (ctx, req) => {
        const session = requireSession(req);
        const row = await putRecord(ctx, req.params.collection ?? '', undefined, req.body, session);
        return { status: 201, body: row };
      },
    },
    {
      method: 'PUT',
      path: '/records/:collection/:rkey',
      auth: 'member',
      handler: async (ctx, req) => {
        const session = requireSession(req);
        const row = await putRecord(ctx, req.params.collection ?? '', req.params.rkey, req.body, session);
        return { status: 200, body: row };
      },
    },
    {
      method: 'DELETE',
      path: '/records/:collection/:rkey',
      auth: 'member',
      handler: async (ctx, req) => {
        const session = requireSession(req);
        await deleteRecord(ctx, req.params.collection ?? '', req.params.rkey ?? '', session);
        return { status: 204, body: null };
      },
    },
    {
      method: 'GET',
      path: '/schema-org/:type',
      auth: 'none',
      handler: async (ctx, req) => {
        const graph = await schemaOrgGraph(ctx, req.params.type ?? '');
        return { body: graph };
      },
    },
    {
      method: 'GET',
      path: '/places/resolve',
      auth: 'none',
      handler: async (ctx, req) => {
        const lat = requireNumber(req.query.lat, 'lat');
        const lon = requireNumber(req.query.lon, 'lon');
        const resolved = await resolvePlace(ctx, lat, lon, deps);
        return { body: resolved };
      },
    },
  ];
}
