/**
 * Security headers for every response (`next.config.ts` `headers()`). Pure so it is unit-tested and so
 * `next.config.ts` can import it without the server-only env module.
 *
 * Content-Security-Policy baseline (final review, Task 19):
 *   default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
 *   font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:;
 *   connect-src 'self' https://*.bioregionalpassport.org https://bioregionalpassport.org
 *     https://tiles.openfreemap.org https://tile.openstreetmap.org;
 *   worker-src 'self' blob:; child-src blob:; frame-src 'none';
 *   frame-ancestors 'none'; base-uri 'self'; form-action 'self'
 *
 * Relaxations, each needed by something that ships (documented here, nowhere else):
 * - script-src 'unsafe-inline': the App Router streams inline bootstrap/flight scripts (`self.__next_f.push`)
 *   and we use no nonce middleware.
 * - style-src 'unsafe-inline': React `style={…}` props, ThemeProvider's CSS variables, and html5-qrcode's
 *   injected scanner styles.
 * - img-src data: blob: https:: html5-qrcode's inline icons (data:), downloads/previews via object URLs (blob:),
 *   and pod logos from arbitrary manifest URLs (https:).
 * - connect-src adds `https://<PLATFORM_DOMAIN>` and `https://*.<PLATFORM_DOMAIN>` when PLATFORM_DOMAIN is not the
 *   default, and `https://<domain>` for every custom pod domain in POD_CUSTOM_DOMAINS: the wallet (platform
 *   origin) calls a pod's own origin (`services.*` in its manifest) with credentials.
 * - connect-src https://tiles.openfreemap.org https://tile.openstreetmap.org: the pod map (MapLibre, Task 20)
 *   fetches the OpenFreeMap style, vector tiles, sprites and glyphs, and OSM raster fallback tiles.
 * - worker-src 'self' blob: and child-src blob:: MapLibre starts its worker from a blob URL (child-src for older
 *   Safari, which ignores worker-src).
 * - development only: script-src 'unsafe-eval' (React dev call stacks / Turbopack HMR) and connect-src for
 *   `http(s)://localhost:*`, `http://*.localhost:*` and `ws(s)://…` (HMR websocket, `<slug>.localhost` pod hosts).
 *
 * Not restricted: camera access for the QR scanner (getUserMedia is not governed by CSP; no Permissions-Policy
 * is sent, so the default same-origin camera permission applies).
 */
export interface SecurityHeaderOptions {
  isDev: boolean;
  platformDomain?: string;
  /** Raw `POD_CUSTOM_DOMAINS` (`domain=slug,…`). */
  customDomains?: string;
}

const DEFAULT_DOMAIN = 'bioregionalpassport.org';
/** Map style/tiles/glyphs (OpenFreeMap) and the raster fallback (OSM) used by the pod map. */
const MAP_TILE_ORIGINS = ['https://tiles.openfreemap.org', 'https://tile.openstreetmap.org'];

export function contentSecurityPolicy(opts: SecurityHeaderOptions): string {
  const domain = (opts.platformDomain?.trim() || DEFAULT_DOMAIN).toLowerCase();
  const connect = new Set(["'self'", `https://*.${DEFAULT_DOMAIN}`, `https://${DEFAULT_DOMAIN}`, `https://*.${domain}`, `https://${domain}`, ...MAP_TILE_ORIGINS]);
  for (const pair of (opts.customDomains ?? '').split(',')) {
    const host = pair.split('=')[0]?.trim().toLowerCase();
    if (host && /^[a-z0-9.-]+$/.test(host)) connect.add(`https://${host}`);
  }
  const script = ["'self'", "'unsafe-inline'"];
  if (opts.isDev) {
    script.push("'unsafe-eval'");
    for (const src of ['http://localhost:*', 'http://*.localhost:*', 'ws://localhost:*', 'ws://*.localhost:*', 'wss://localhost:*']) connect.add(src);
  }
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    `connect-src ${[...connect].join(' ')}`,
    "worker-src 'self' blob:",
    'child-src blob:',
    // Nothing is ever framed; child-src would otherwise let blob: frames in.
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

export function securityHeaders(opts: SecurityHeaderOptions): { key: string; value: string }[] {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(opts) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
  ];
}
