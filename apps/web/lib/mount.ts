/**
 * `mountService` — mounts a framework-agnostic service route table (plan §4.5)
 * as a Next.js catch-all route handler (`app/api/<service>/[[...path]]/route.ts`).
 *
 * Per request: parse method + path → match the route table (`:param`
 * segments) → resolve the tenant (pod scope) → read the `passport_session`
 * cookie → enforce `route.auth` → open `withPod` and build the `PodContext`
 * (or a `PlatformContext`) → call the handler → map errors to
 * `{ code, message, hint? }`.
 *
 * This module is framework-light on purpose (plain `Request`/`Response`) so it
 * is unit-testable; the real database/session wiring lives in `./runtime`,
 * loaded lazily unless test doubles are injected.
 */
import type { RouteAuth, RouteRequest, RouteResult, SessionClaims } from '@passport/service-kit';
import { resolveSlug, type HostConfig } from './tenant';
import { SESSION_COOKIE, SESSION_MAX_AGE_SEC, clearSessionCookieHeader, readCookie, sessionCookieHeader } from './cookies';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Any service route: pod routes take a `PodContext`, platform routes a `PlatformContext`. */
export interface MountableRoute {
  method: Method;
  path: string;
  auth?: RouteAuth;
  // Contexts differ per scope; the mount builds the right one for `opts.scope`.
  handler: (ctx: any, req: RouteRequest) => Promise<RouteResult>;
}

export interface MountOptions {
  /** URL prefix the route table is mounted under, e.g. `/api/index`. */
  base: string;
  scope: 'pod' | 'platform';
  /** Runs inside the pod transaction before the handler (e.g. ensure side tables). */
  prepare?: (db: any) => Promise<void>;
  /** Adds `DELETE <base>/session` that clears the session cookie (the VTA mount). */
  sessionEndpoint?: boolean;
  /** Message for a 404 on an unmatched path (e.g. a service that is not deployed yet). */
  notFoundMessage?: string;
}

export interface PodInfo {
  slug: string;
  did: string;
  manifest: any;
  policy: any;
  status: string;
}

/** Everything the mount needs from the outside world; `./runtime` supplies the real thing. */
export interface MountDeps {
  platformDomain: string;
  customDomains?: Record<string, string>;
  operatorToken?: string | undefined;
  secureCookies: boolean;
  masterKey?: string;
  findPod(slug: string): Promise<PodInfo | null>;
  /** Runs `fn` in a transaction scoped to the pod schema (`withPod`). */
  withPod<T>(slug: string, fn: (db: any) => Promise<T>): Promise<T>;
  /** Unscoped platform database handle. */
  platformDb(): any;
  readSession(token: string): Promise<SessionClaims | null>;
  now?: () => Date;
  logError?: (err: unknown, where: string) => void;
}

export type RouteHandler = (req: Request) => Promise<Response>;
export interface MountedService {
  GET: RouteHandler;
  POST: RouteHandler;
  PUT: RouteHandler;
  DELETE: RouteHandler;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Mount-level error with the same shape as service-kit's `ServiceError`. */
export class MountError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'MountError';
  }
}

interface ErrorLike {
  status: number;
  code: string;
  message: string;
  hint?: string;
}

/** Duck-typed so a `ServiceError` from any copy of `@passport/service-kit` maps correctly. */
function isServiceError(err: unknown): err is ErrorLike {
  if (!(err instanceof Error)) return false;
  const e = err as Partial<ErrorLike> & { name?: string };
  return (
    (e.name === 'ServiceError' || e.name === 'MountError') &&
    typeof e.status === 'number' &&
    e.status >= 400 &&
    e.status < 600 &&
    typeof e.code === 'string'
  );
}

/** Maps a thrown value to an HTTP status + `{code,message,hint?}`; unknown errors become an opaque 500. */
export function errorToResponse(err: unknown, logError?: (err: unknown, where: string) => void, where = 'mount'): Response {
  if (isServiceError(err)) {
    const body: { code: string; message: string; hint?: string } = { code: err.code, message: err.message };
    if (err.hint !== undefined) body.hint = err.hint;
    return json(err.status, body);
  }
  (logError ?? defaultLog)(err, where);
  return json(500, { code: 'INTERNAL', message: 'Something went wrong on our side; please try again.' });
}

function defaultLog(err: unknown, where: string): void {
  console.error(`[${where}]`, err);
}

function json(status: number, body: unknown, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set('content-type', 'application/json; charset=utf-8');
  h.set('cache-control', 'no-store');
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: h });
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

const segments = (p: string): string[] => p.split('/').filter((s) => s.length > 0);

/** Matches `path` against a pattern with `:param` segments; returns params or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = segments(pattern);
  const got = segments(path);
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = got[i]!;
    if (w.startsWith(':')) {
      try {
        params[w.slice(1)] = decodeURIComponent(g);
      } catch {
        return null;
      }
    } else if (w !== g) {
      return null;
    }
  }
  return params;
}

export type MatchResult<R> =
  | { kind: 'match'; route: R; params: Record<string, string> }
  | { kind: 'method-not-allowed'; allowed: Method[] }
  | { kind: 'not-found' };

/** Finds the route for `method path`; distinguishes 404 from 405. Static segments win over params. */
export function matchRoute<R extends { method: Method; path: string }>(routes: R[], method: string, path: string): MatchResult<R> {
  const hits = routes
    .map((route) => ({ route, params: matchPath(route.path, path) }))
    .filter((h): h is { route: R; params: Record<string, string> } => h.params !== null);
  if (hits.length === 0) return { kind: 'not-found' };
  const forMethod = hits.filter((h) => h.route.method === method);
  if (forMethod.length === 0) return { kind: 'method-not-allowed', allowed: [...new Set(hits.map((h) => h.route.method))] };
  // Prefer the most specific pattern (fewest `:param` segments).
  forMethod.sort((a, b) => Object.keys(a.params).length - Object.keys(b.params).length);
  const best = forMethod[0]!;
  return { kind: 'match', route: best.route, params: best.params };
}

/** Path below the mount base: `/api/index/me/explanation` with base `/api/index` → `/me/explanation`. */
export function subPath(pathname: string, base: string): string {
  const b = base.replace(/\/+$/, '');
  if (pathname === b) return '/';
  if (pathname.startsWith(`${b}/`)) return pathname.slice(b.length) || '/';
  return pathname;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  const m = h ? /^Bearer\s+(.+)$/i.exec(h.trim()) : null;
  return m?.[1]?.trim() ?? null;
}

const UNAUTHENTICATED = () => new MountError(401, 'UNAUTHENTICATED', 'You need to present your passport before doing this.');

/**
 * Enforces `route.auth`. `podDid` is set for pod-scoped mounts: a session
 * minted by another pod never satisfies member/authority gates here.
 */
export function checkAuth(
  auth: RouteAuth | undefined,
  input: { session: SessionClaims | null; podDid?: string; bearerToken: string | null; operatorToken?: string | undefined },
): void {
  const { session, podDid } = input;
  const samePod = (s: SessionClaims) => podDid === undefined || s.pod === podDid;
  const needAuthority = (scope: string) => {
    if (!session) throw UNAUTHENTICATED();
    if (!samePod(session)) {
      throw new MountError(403, 'POD_MISMATCH', 'Your passport session was issued by a different pod.', 'Present your passport to this pod first.');
    }
    if (!session.authorities.includes(scope)) {
      throw new MountError(403, 'MISSING_AUTHORITY', `This needs the "${scope}" authority, which your passport does not carry.`);
    }
  };

  if (auth === undefined || auth === 'none') return;
  if (auth === 'member') {
    if (!session) throw UNAUTHENTICATED();
    if (!samePod(session)) {
      throw new MountError(403, 'POD_MISMATCH', 'Your passport session was issued by a different pod.', 'Present your passport to this pod first.');
    }
    return;
  }
  if (auth === 'steward') return needAuthority('pep:review');
  if (auth === 'operator') {
    const token = input.bearerToken;
    if (token !== null) {
      if (input.operatorToken && constantTimeEqual(token, input.operatorToken)) return;
      throw new MountError(403, 'OPERATOR_ONLY', 'That operator key is not valid.');
    }
    if (!session) {
      throw new MountError(401, 'OPERATOR_ONLY', 'Only a pod operator can do this.', 'Send the operator key in an Authorization: Bearer header, or present a passport carrying registry:propose.');
    }
    return needAuthority('registry:propose');
  }
  if (auth.startsWith('authority:')) return needAuthority(auth.slice('authority:'.length));
  throw new MountError(500, 'BAD_ROUTE_AUTH', `Unknown route auth ${String(auth)}.`);
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

async function parseBody(req: Request): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const text = await req.text();
  if (text.trim().length === 0) return undefined;
  const type = req.headers.get('content-type') ?? '';
  if (type && !/json/i.test(type)) {
    throw new MountError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the request body as JSON.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MountError(400, 'BAD_JSON', 'The request body is not valid JSON.');
  }
}

function queryOf(url: URL): Record<string, string> {
  const q: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (!(k in q)) q[k] = v;
  return q;
}

async function sessionOf(req: Request, deps: MountDeps): Promise<SessionClaims | null> {
  const token = readCookie(req.headers.get('cookie'), SESSION_COOKIE);
  if (!token) return null;
  try {
    return await deps.readSession(token);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export type DepsSource = MountDeps | (() => Promise<MountDeps>);

async function loadRuntimeDeps(): Promise<MountDeps> {
  const mod = await import('./runtime');
  return mod.runtimeDeps();
}

/** Builds the `{ GET, POST, PUT, DELETE }` handlers for a catch-all route file. */
export function mountService(routes: MountableRoute[], opts: MountOptions, depsSource?: DepsSource): MountedService {
  const getDeps = async (): Promise<MountDeps> =>
    depsSource === undefined ? loadRuntimeDeps() : typeof depsSource === 'function' ? depsSource() : depsSource;

  const handle: RouteHandler = async (req) => {
    let deps: MountDeps | undefined;
    try {
      deps = await getDeps();
      const url = new URL(req.url);
      const path = subPath(url.pathname, opts.base);
      const method = req.method.toUpperCase();

      if (opts.sessionEndpoint && method === 'DELETE' && path.replace(/\/+$/, '') === '/session') {
        return json(200, { ok: true }, { 'set-cookie': clearSessionCookieHeader(deps.secureCookies) });
      }

      const match = matchRoute(routes, method, path);
      if (match.kind === 'not-found') {
        throw new MountError(404, 'NOT_FOUND', opts.notFoundMessage ?? `There is nothing at ${opts.base}${path === '/' ? '' : path}.`);
      }
      if (match.kind === 'method-not-allowed') {
        return json(405, { code: 'METHOD_NOT_ALLOWED', message: `Use ${match.allowed.join(' or ')} here.` }, { allow: match.allowed.join(', ') });
      }
      const { route, params } = match;
      const hostCfg: HostConfig = { platformDomain: deps.platformDomain, customDomains: deps.customDomains ?? {} };
      const now = deps.now ?? (() => new Date());

      let pod: PodInfo | null = null;
      if (opts.scope === 'pod') {
        const slug = resolveSlug(req, hostCfg);
        if (!slug) {
          throw new MountError(404, 'POD_NOT_FOUND', 'This request does not name a pod.', 'Use a pod address such as boulder.<domain>, or send an X-Pod header.');
        }
        pod = await deps.findPod(slug);
        if (!pod || pod.status !== 'active') throw new MountError(404, 'POD_NOT_FOUND', `No active pod is registered as ${slug}.`);
      }

      const session = await sessionOf(req, deps);
      checkAuth(route.auth, {
        session,
        ...(pod ? { podDid: pod.did } : {}),
        bearerToken: bearer(req),
        operatorToken: deps.operatorToken,
      });

      const routeReq: RouteRequest = { params, query: queryOf(url), body: await parseBody(req) };
      if (session) routeReq.session = session;

      let result: RouteResult;
      if (pod) {
        const p = pod;
        result = await deps.withPod(p.slug, async (db) => {
          if (opts.prepare) await opts.prepare(db);
          return route.handler(
            { slug: p.slug, podDid: p.did, db, manifest: p.manifest, policy: p.policy, now, platformDomain: deps!.platformDomain },
            routeReq,
          );
        });
      } else {
        const ctx: Record<string, unknown> = { db: deps.platformDb(), platformDomain: deps.platformDomain, now };
        if (deps.masterKey) ctx['masterKey'] = deps.masterKey;
        result = await route.handler(ctx, routeReq);
      }

      const headers = new Headers();
      const token = (result.body as { token?: unknown } | null | undefined)?.token;
      const trimmed = path.replace(/\/+$/, '');
      const isSessionPath = trimmed === '/session' || trimmed.startsWith('/session/');
      if (method === 'POST' && isSessionPath && typeof token === 'string' && token.length > 0) {
        headers.append('set-cookie', sessionCookieHeader(token, deps.secureCookies));
      }
      return json(result.status ?? 200, result.body ?? null, headers);
    } catch (err) {
      return errorToResponse(err, deps?.logError, `api ${opts.base}`);
    }
  };

  return { GET: handle, POST: handle, PUT: handle, DELETE: handle };
}

export { SESSION_COOKIE, SESSION_MAX_AGE_SEC };
