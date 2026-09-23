import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';

const rewriteOf = (res: Response) => res.headers.get('x-middleware-rewrite');
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

function run(url: string, headers: Record<string, string> = {}) {
  const u = new URL(url);
  return proxy(new NextRequest(url, { headers: { host: u.host, ...headers } }));
}

describe('proxy', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['PLATFORM_DOMAIN'];
    process.env['PLATFORM_DOMAIN'] = 'bioregionalpassport.org';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['PLATFORM_DOMAIN'];
    else process.env['PLATFORM_DOMAIN'] = saved;
  });

  it('rewrites pod-host pages onto /p/<slug>', () => {
    const res = run('https://boulder.bioregionalpassport.org/events');
    expect(new URL(rewriteOf(res)!).pathname).toBe('/p/boulder/events');
    expect(forwarded(res, 'x-pod')).toBe('boulder');
    const home = run('https://boulder.bioregionalpassport.org/');
    expect(new URL(rewriteOf(home)!).pathname).toBe('/p/boulder');
    const card = run('https://boulder.bioregionalpassport.org/.well-known/bioregion.json');
    expect(new URL(rewriteOf(card)!).pathname).toBe('/p/boulder/.well-known/bioregion.json');
  });

  it('passes PWA files, APIs, DIDs and .well-known through on a pod host, still setting x-pod', () => {
    for (const path of ['/manifest.webmanifest', '/icon.svg', '/_next/webpack-hmr', '/api/vta/challenge', '/dids/boulder/did.json', '/.well-known/security.txt']) {
      const res = run(`https://boulder.bioregionalpassport.org${path}`, { 'x-pod': 'evil' });
      expect(rewriteOf(res), path).toBeNull();
      expect(res.headers.get('location'), path).toBeNull();
      expect(forwarded(res, 'x-pod'), path).toBe('boulder');
      expect(forwarded(res, 'x-pod-host'), path).toBe('1');
    }
  });

  it('redirects (307) /wallet on a pod host to the platform host with ?pod=<slug>', () => {
    const res = run('https://boulder.bioregionalpassport.org/wallet/events?x=1');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://bioregionalpassport.org/wallet/events?x=1&pod=boulder');
    const local = run('http://boulder.localhost:3000/wallet');
    expect(local.status).toBe(307);
    expect(local.headers.get('location')).toBe('http://localhost:3000/wallet?pod=boulder');
  });

  it('redirects (307) the wallet-dependent sections on a pod host to <platform>/p/<slug>/…, keeping the query', () => {
    const cases: [string, string][] = [
      ['https://boulder.bioregionalpassport.org/grants', 'https://bioregionalpassport.org/p/boulder/grants'],
      ['https://boulder.bioregionalpassport.org/grants/r1/propose?x=1', 'https://bioregionalpassport.org/p/boulder/grants/r1/propose?x=1'],
      ['https://boulder.bioregionalpassport.org/circulation', 'https://bioregionalpassport.org/p/boulder/circulation'],
      ['https://boulder.bioregionalpassport.org/circulation/receipt/abc?y=2', 'https://bioregionalpassport.org/p/boulder/circulation/receipt/abc?y=2'],
      ['https://boulder.bioregionalpassport.org/merchant', 'https://bioregionalpassport.org/p/boulder/merchant'],
      ['https://boulder.bioregionalpassport.org/p/boulder/merchant/', 'https://bioregionalpassport.org/p/boulder/merchant/'],
      ['http://boulder.localhost:3000/circulation?a=b', 'http://localhost:3000/p/boulder/circulation?a=b'],
    ];
    for (const [from, to] of cases) {
      const res = run(from);
      expect(res.status, from).toBe(307);
      expect(res.headers.get('location'), from).toBe(to);
    }
  });

  it('keeps home, map, directory, events, governance and steward on the pod host (no redirect)', () => {
    for (const path of ['/', '/map', '/directory', '/events', '/events/e1', '/governance', '/steward', '/grantsx', '/merchants']) {
      const res = run(`https://boulder.bioregionalpassport.org${path}`);
      expect(res.headers.get('location'), path).toBeNull();
      expect(rewriteOf(res), path).not.toBeNull();
    }
  });

  it('does not redirect the wallet-dependent sections on the platform host', () => {
    const res = run('https://bioregionalpassport.org/p/boulder/grants');
    expect(res.headers.get('location')).toBeNull();
  });

  it('leaves the platform host alone and drops a client x-pod outside /api', () => {
    const res = run('https://bioregionalpassport.org/wallet', { 'x-pod': 'boulder' });
    expect(rewriteOf(res)).toBeNull();
    expect(forwarded(res, 'x-pod')).toBeNull();
  });
});
