/**
 * Tenant (pod slug) resolution — pure, shared by `proxy.ts`, `mountService`
 * and pages. Plan §1 / B2 §2.3 order: custom domain → `<slug>.<PLATFORM_DOMAIN>`
 * → `/p/<slug>` path prefix → `X-Pod` header → `?pod=` query. The host always
 * wins, so a client-sent `X-Pod` can never re-target a pod host's request.
 */

export const SLUG_RE = /^[a-z0-9-]{2,40}$/;

/** Sub-domains of the platform domain that are the platform site, never a pod. */
export const RESERVED_SUBDOMAINS = new Set(['www', 'api', 'app']);

export const isSlug = (v: unknown): v is string => typeof v === 'string' && SLUG_RE.test(v);

export interface HostConfig {
  platformDomain: string;
  customDomains?: Record<string, string>;
}

/** Lower-cased host without port. */
export function normalizeHost(host: string | null | undefined): string {
  return (host ?? '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

/**
 * The pod slug a host addresses, or `null` for the platform site
 * (bare domain, `www.`, localhost, Vercel preview hosts, unknown hosts).
 */
export function slugFromHost(rawHost: string | null | undefined, cfg: HostConfig): string | null {
  const host = normalizeHost(rawHost);
  if (!host) return null;
  const custom = cfg.customDomains?.[host];
  if (custom && isSlug(custom)) return custom;
  for (const base of [cfg.platformDomain.toLowerCase(), 'localhost']) {
    if (host.endsWith(`.${base}`)) {
      const sub = host.slice(0, -(base.length + 1));
      if (sub.includes('.') || RESERVED_SUBDOMAINS.has(sub)) return null;
      return isSlug(sub) ? sub : null;
    }
  }
  return null;
}

/** `/p/<slug>/…` → slug. */
export function slugFromPath(pathname: string): string | null {
  const m = /^\/p\/([^/]+)(?:\/|$)/.exec(pathname);
  const slug = m?.[1] ? decodeURIComponent(m[1]) : null;
  return isSlug(slug) ? slug : null;
}

/**
 * Resolves the tenant for a request: host (custom domain or `<slug>.<domain>`)
 * → `/p/<slug>` path → `x-pod` header → `?pod=` query. Every candidate is
 * validated with the slug regex; the first valid one wins.
 */
export function resolveSlug(req: Request, cfg: HostConfig): string | null {
  const url = new URL(req.url);
  const fromHost = slugFromHost(req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host, cfg);
  if (fromHost) return fromHost;
  const fromPath = slugFromPath(url.pathname);
  if (fromPath) return fromPath;
  const header = req.headers.get('x-pod')?.trim().toLowerCase();
  if (isSlug(header)) return header;
  const q = url.searchParams.get('pod')?.trim().toLowerCase();
  return isSlug(q) ? q : null;
}
