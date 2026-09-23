/**
 * Service handler shape (§4.5) from `@passport/service-kit`, narrowed to the
 * platform types. Registry and control routes are platform-level (not scoped to
 * a pod), so they take a `PlatformContext` instead of a `PodContext`.
 */
import type { Db } from '@passport/db';
import type { BioregionManifest, TrustPolicy } from '@passport/tenant-config';
import type {
  HttpMethod,
  PodContext as KitPodContext,
  RouteAuth,
  RouteRequest,
  RouteResult,
} from '@passport/service-kit';

export { ServiceError, errorResult } from '@passport/service-kit';
export type { HttpMethod, RouteAuth, RouteRequest, RouteResult, SessionClaims } from '@passport/service-kit';

export type PodContext = KitPodContext<BioregionManifest, TrustPolicy, Db>;

export interface PlatformContext {
  db: Db;
  platformDomain: string;
  /** `POD_KEY_ENCRYPTION_KEY` (64 hex chars); required by the control routes. */
  masterKey?: string;
  now?: () => Date;
}

/** Same shape as service-kit `Route`, but for platform-level handlers. */
export interface Route<Ctx = PlatformContext> {
  method: HttpMethod;
  path: string;
  auth?: RouteAuth;
  handler: (ctx: Ctx, req: RouteRequest) => Promise<RouteResult>;
}
