/**
 * @passport/service-kit — the framework-agnostic service handler shape shared by
 * every `services/*` package (MVP plan §4.5). Dependency-free on purpose: the
 * pod-specific types (`Db`, `BioregionManifest`, `TrustPolicy`) are supplied as
 * type parameters by each service so this package never pins them.
 */

/** Minimal database handle a pod service receives (structurally identical to `@passport/db` `Db`). */
export interface ServiceDb {
  query<T = any>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: ServiceDb) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Per-request pod context. `db` is already scoped to the pod schema by `withPod`.
 * Services narrow `TManifest` / `TPolicy` to `BioregionManifest` / `TrustPolicy`.
 */
export interface PodContext<TManifest = unknown, TPolicy = unknown, TDb extends ServiceDb = ServiceDb> {
  slug: string;
  podDid: string;
  db: TDb;
  manifest: TManifest;
  policy: TPolicy;
  now: () => Date;
  platformDomain: string;
}

/** Verified session claims (from `readSession` in `@passport/verifier-sdk`). */
export interface SessionClaims {
  subject: string;
  pod: string;
  tier?: string;
  authorities: string[];
  delegatedFor?: string;
}

export interface RouteRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
  session?: SessionClaims;
}

export interface RouteResult {
  status?: number;
  /** JSON-serialised by the mount layer, unless it is a string and `headers` sets a non-JSON content type. */
  body: any;
  /** Extra response headers (e.g. `content-type: text/csv` for a CSV export body string). */
  headers?: Record<string, string>;
}

export type RouteAuth = 'none' | 'member' | 'steward' | 'operator' | `authority:${string}`;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface Route<TCtx extends PodContext<any, any, any> = PodContext> {
  method: HttpMethod;
  /** e.g. '/membership/apply'; ':id' segments become `req.params.id`. */
  path: string;
  auth?: RouteAuth;
  handler: (ctx: TCtx, req: RouteRequest) => Promise<RouteResult>;
}

/** JSON error body per plan §1: `{ code, message, hint? }`. */
export interface ErrorBody {
  code: string;
  message: string;
  hint?: string;
}

/** A gate or validation failure that explains itself in one plain sentence. */
export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint?: string;

  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }

  toJSON(): ErrorBody {
    return this.hint === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, hint: this.hint };
  }
}

/** Maps any thrown value to `{ status, body }`; unknown errors become a 500 without leaking internals. */
export function errorResult(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof ServiceError) return { status: err.status, body: err.toJSON() };
  return { status: 500, body: { code: 'INTERNAL', message: 'Something went wrong on our side; please try again.' } };
}

/** Returns the session or throws 401 `UNAUTHENTICATED`. */
export function requireSession(req: RouteRequest): SessionClaims {
  if (!req.session || !req.session.subject) {
    throw new ServiceError(401, 'UNAUTHENTICATED', 'You need to present your passport before doing this.');
  }
  return req.session;
}

/**
 * Returns the session when it carries authority `scope` (e.g. `pep:review`; an
 * `authority:` prefix is tolerated), else throws 401/403 `MISSING_AUTHORITY`.
 */
export function requireAuthority(req: RouteRequest, scope: string): SessionClaims {
  const session = requireSession(req);
  const wanted = scope.startsWith('authority:') ? scope.slice('authority:'.length) : scope;
  if (!session.authorities.includes(wanted)) {
    throw new ServiceError(
      403,
      'MISSING_AUTHORITY',
      `This needs the "${wanted}" authority, which your passport does not carry.`,
    );
  }
  return session;
}
