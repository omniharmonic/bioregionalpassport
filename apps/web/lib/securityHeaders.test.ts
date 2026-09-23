import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, securityHeaders } from './securityHeaders';

const directives = (csp: string) => new Map(csp.split('; ').map((d) => [d.split(' ')[0]!, d.split(' ').slice(1)]));

describe('security headers', () => {
  it('production CSP is the reviewed baseline', () => {
    expect(contentSecurityPolicy({ isDev: false })).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; " +
        "connect-src 'self' https://*.bioregionalpassport.org https://bioregionalpassport.org " +
        'https://tiles.openfreemap.org https://tile.openstreetmap.org; ' +
        "worker-src 'self' blob:; child-src blob:; frame-src 'none'; " +
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  });

  it('never allows eval in production; allows it and the HMR socket in development', () => {
    expect(directives(contentSecurityPolicy({ isDev: false })).get('script-src')).not.toContain("'unsafe-eval'");
    const dev = directives(contentSecurityPolicy({ isDev: true }));
    expect(dev.get('script-src')).toContain("'unsafe-eval'");
    expect(dev.get('connect-src')).toEqual(expect.arrayContaining(['ws://localhost:*', 'http://*.localhost:*']));
  });

  it('adds a non-default platform domain and custom pod domains to connect-src', () => {
    const connect = directives(
      contentSecurityPolicy({ isDev: false, platformDomain: 'Example.org', customDomains: 'passport.boulder.coop=boulder, bad domain=x' }),
    ).get('connect-src');
    expect(connect).toEqual(expect.arrayContaining(['https://example.org', 'https://*.example.org', 'https://passport.boulder.coop']));
    expect(connect?.some((s) => s.includes('bad'))).toBe(false);
  });

  it('lets the pod map fetch tiles and start its blob worker', () => {
    const d = directives(contentSecurityPolicy({ isDev: false }));
    expect(d.get('connect-src')).toEqual(expect.arrayContaining(['https://tiles.openfreemap.org', 'https://tile.openstreetmap.org']));
    expect(d.get('worker-src')).toEqual(["'self'", 'blob:']);
    expect(d.get('child-src')).toEqual(['blob:']);
    expect(d.get('frame-src')).toEqual(["'none'"]);
    expect(d.get('img-src')).toContain('https:');
  });

  it('sends nosniff, a strict referrer policy and DENY framing', () => {
    const h = Object.fromEntries(securityHeaders({ isDev: false }).map((x) => [x.key, x.value]));
    expect(h).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
    });
    expect(h['Content-Security-Policy']).toContain("frame-ancestors 'none'");
  });
});
