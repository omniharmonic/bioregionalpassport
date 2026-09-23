import { NextResponse, type NextRequest } from 'next/server';
import { slugFromHost } from './lib/tenant';

/**
 * Tenant routing (B2 §2.3). A pod host (`<slug>.<PLATFORM_DOMAIN>`,
 * `<slug>.localhost:3000`, or a custom domain from `POD_CUSTOM_DOMAINS`) is
 * rewritten onto `/p/<slug>/…` and every request from it carries an
 * authoritative `x-pod` header. The bare platform domain and `www.` stay the
 * platform site.
 */

/** Paths on a pod host that are shared app routes, not pod pages. */
const PASSTHROUGH = [/^\/api(\/|$)/, /^\/wallet(\/|$)/, /^\/dids(\/|$)/, /^\/_next(\/|$)/];

function customDomains(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (process.env['POD_CUSTOM_DOMAINS'] ?? '').split(',')) {
    const [domain, slug] = pair.split('=').map((s) => s.trim().toLowerCase());
    if (domain && slug) out[domain] = slug;
  }
  return out;
}

export function proxy(request: NextRequest) {
  const platformDomain = (process.env['PLATFORM_DOMAIN'] || 'bioregionalpassport.org').toLowerCase();
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const slug = slugFromHost(host, { platformDomain, customDomains: customDomains() });
  if (!slug) return NextResponse.next();

  const headers = new Headers(request.headers);
  headers.set('x-pod', slug);
  headers.set('x-pod-host', '1');

  const { pathname } = request.nextUrl;
  const alreadyScoped = pathname === `/p/${slug}` || pathname.startsWith(`/p/${slug}/`);
  if (alreadyScoped || PASSTHROUGH.some((re) => re.test(pathname))) {
    return NextResponse.next({ request: { headers } });
  }
  const url = request.nextUrl.clone();
  url.pathname = `/p/${slug}${pathname === '/' ? '' : pathname}`;
  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
};
