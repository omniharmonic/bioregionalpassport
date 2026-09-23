/**
 * @passport/appview — the pod's public open-records read layer (MVP plan §5 Task 10, ADR-24).
 *
 * Records are open (anyone can read); writing needs a member session. Every
 * function here expects a `PodContext` whose `db` is already scoped to the
 * pod schema (via `withPod`) — see `src/kit.ts` for the shared handler
 * contract, kept locally until `@passport/service-kit` lands (see the Task
 * 10 report for status).
 */
export {
  type PodContext,
  type Route,
  type RouteRequest,
  type RouteResult,
  type RouteAuth,
  type SessionClaims,
  ServiceError,
  requireSession,
  requireAuthority,
} from './kit.js';

export {
  type RecordRow,
  type RecordFilter,
  listRecords,
  getRecord,
  putRecord,
  deleteRecord,
  hasAnyRecords,
} from './records.js';

export { type GeoJsonFeature, type GeoJsonFeatureCollection, listMapFeatures, effectiveBbox } from './map.js';
export { type Bbox, type Bounds, parseBbox, pointInBbox, boundsToBbox } from './geo.js';
export { type DirectoryEntry, type DirectoryFilter, listDirectory } from './directory.js';
export { searchRecords } from './search.js';
export { type SchemaOrgType, schemaOrgGraph } from './schemaOrg.js';
export { type ResolvedPlace, type ResolvePlaceDeps, resolvePlace } from './places.js';
export { generateTid } from './tid.js';
export { seedDemoRecords } from './seed.js';
export { type AppviewDeps, createAppviewRoutes } from './routes.js';
