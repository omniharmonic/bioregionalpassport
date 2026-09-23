/**
 * Pod-typed aliases of the shared service-handler contract from
 * `@passport/service-kit` (MVP plan §4.5), binding its generic `PodContext`/
 * `Route` to this pod's concrete `Db`/`BioregionManifest`/`TrustPolicy`
 * types. `@passport/service-kit` landed after this package's Task 10 work
 * started (it began as a local copy here) — see the Task 10 report.
 */
import type { Db } from '@passport/db';
import type { BioregionManifest, TrustPolicy } from '@passport/tenant-config';
import {
  type PodContext as BasePodContext,
  type Route as BaseRoute,
  type RouteRequest,
  type RouteResult,
  type RouteAuth,
  type SessionClaims,
  ServiceError,
  requireSession,
  requireAuthority,
} from '@passport/service-kit';

export type PodContext = BasePodContext<BioregionManifest, TrustPolicy, Db>;
export type Route = BaseRoute<PodContext>;

export type { RouteRequest, RouteResult, RouteAuth, SessionClaims };
export { ServiceError, requireSession, requireAuthority };
