import { describe, expect, it } from 'vitest';
import {
  isPlatformOnlyPodPath,
  isPodHostPassthrough,
  isWalletPath,
  platformOriginFor,
  podSectionRedirectUrl,
  resolveSlug,
  walletRedirectUrl,
  slugFromHost,
  slugFromPath,
} from './tenant';

const cfg = { platformDomain: 'bioregionalpassport.org', customDomains: { 'commons.boulder.org': 'boulder' } };

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

describe('slugFromHost', () => {
  it('maps <slug>.<platform domain> to the slug', () => {
    expect(slugFromHost('boulder.bioregionalpassport.org', cfg)).toBe('boulder');
    expect(slugFromHost('Tenant-Zero.BioregionalPassport.org:443', cfg)).toBe('tenant-zero');
  });
  it('maps <slug>.localhost:3000 for local development', () => {
    expect(slugFromHost('boulder.localhost:3000', cfg)).toBe('boulder');
  });
  it('maps custom domains from the static map', () => {
    expect(slugFromHost('commons.boulder.org', cfg)).toBe('boulder');
  });
  it('keeps the bare domain, www and unrelated hosts as the platform site', () => {
    for (const h of ['bioregionalpassport.org', 'www.bioregionalpassport.org', 'localhost:3000', 'x.vercel.app', 'a.b.bioregionalpassport.org', '', null]) {
      expect(slugFromHost(h, cfg)).toBeNull();
    }
  });
  it('rejects sub-domains that are not valid slugs', () => {
    expect(slugFromHost('x.bioregionalpassport.org', cfg)).toBeNull();
    expect(slugFromHost('under_score.bioregionalpassport.org', cfg)).toBeNull();
  });
});

describe('slugFromPath', () => {
  it('reads /p/<slug>', () => {
    expect(slugFromPath('/p/boulder')).toBe('boulder');
    expect(slugFromPath('/p/boulder/events')).toBe('boulder');
    expect(slugFromPath('/p/BAD!/events')).toBeNull();
    expect(slugFromPath('/api/index')).toBeNull();
  });
});

describe('resolveSlug order: host → /p/<slug> path → x-pod header → ?pod=', () => {
  it('prefers the host over a client-sent x-pod header', () => {
    expect(resolveSlug(req('https://tenant-zero.bioregionalpassport.org/p/other/x?pod=q1', { 'x-pod': 'boulder' }), cfg)).toBe('tenant-zero');
  });
  it('prefers a custom domain host', () => {
    expect(resolveSlug(req('https://commons.boulder.org/api/index', { 'x-pod': 'tenant-zero' }), cfg)).toBe('boulder');
  });
  it('uses x-forwarded-host when present', () => {
    expect(resolveSlug(req('http://internal/api/index', { 'x-forwarded-host': 'boulder.bioregionalpassport.org' }), cfg)).toBe('boulder');
  });
  it('falls back to the path, which beats the header', () => {
    expect(resolveSlug(req('https://bioregionalpassport.org/p/other/x?pod=q1', { 'x-pod': 'boulder' }), cfg)).toBe('other');
  });
  it('falls back to the x-pod header, which beats the query', () => {
    expect(resolveSlug(req('https://bioregionalpassport.org/api/index/me?pod=q1', { 'x-pod': 'boulder' }), cfg)).toBe('boulder');
  });
  it('falls back to the query', () => {
    expect(resolveSlug(req('https://bioregionalpassport.org/api/index/me?pod=boulder'), cfg)).toBe('boulder');
  });
  it('skips invalid candidates and returns null when nothing is valid', () => {
    expect(resolveSlug(req('https://bioregionalpassport.org/api/x?pod=BAD!', { 'x-pod': '../etc' }), cfg)).toBeNull();
    expect(resolveSlug(req('https://bioregionalpassport.org/api/x?pod=boulder', { 'x-pod': 'Not Valid' }), cfg)).toBe('boulder');
  });
});

describe('isPodHostPassthrough', () => {
  it('passes shared app paths through on a pod host', () => {
    for (const p of [
      '/manifest.webmanifest',
      '/icon.svg',
      '/_next/data/x.json',
      '/api/vta/session',
      '/api',
      '/dids/boulder/did.json',
      '/.well-known/security.txt',
    ]) {
      expect(isPodHostPassthrough(p), p).toBe(true);
    }
  });
  it('rewrites pod pages and the pod manifest; the wallet is not served on pod hosts', () => {
    for (const p of ['/', '/wallet', '/wallet/settings', '/events', '/wallets', '/apis', '/icon.svg.bak', '/manifest.webmanifest/x', '/.well-known/bioregion.json', '/steward']) {
      expect(isPodHostPassthrough(p), p).toBe(false);
    }
  });
});

describe('wallet canonical origin', () => {
  it('recognises /wallet paths', () => {
    expect(isWalletPath('/wallet')).toBe(true);
    expect(isWalletPath('/wallet/events')).toBe(true);
    expect(isWalletPath('/wallets')).toBe(false);
    expect(isWalletPath('/p/boulder/wallet')).toBe(false);
  });
  it('sends a pod host wallet URL to the platform host with ?pod=<slug>, keeping the path and other params', () => {
    const u = walletRedirectUrl(new URL('http://boulder.bioregionalpassport.org/wallet/events?x=1&pod=other'), 'boulder', 'bioregionalpassport.org');
    expect(u.toString()).toBe('https://bioregionalpassport.org/wallet/events?x=1&pod=boulder');
    const custom = walletRedirectUrl(new URL('https://passport.boulder.coop/wallet'), 'boulder', 'bioregionalpassport.org');
    expect(custom.toString()).toBe('https://bioregionalpassport.org/wallet?pod=boulder');
  });
  it('keeps protocol and port for <slug>.localhost', () => {
    const u = walletRedirectUrl(new URL('http://boulder.localhost:3000/wallet?join=boulder'), 'boulder', 'bioregionalpassport.org');
    expect(u.toString()).toBe('http://localhost:3000/wallet?join=boulder&pod=boulder');
  });
});

describe('pod-host sections served from the platform origin', () => {
  it('lists grants, circulation and merchant (and subpaths) only', () => {
    for (const p of ['/grants', '/grants/', '/grants/r1', '/circulation', '/circulation/steward', '/merchant']) expect(isPlatformOnlyPodPath(p), p).toBe(true);
    for (const p of ['/', '/map', '/directory', '/events', '/governance', '/steward', '/grantsx', '/wallet']) expect(isPlatformOnlyPodPath(p), p).toBe(false);
  });
  it('platformOriginFor maps <slug>.localhost to localhost and everything else to https://<platform>', () => {
    expect(platformOriginFor(new URL('http://boulder.localhost:3000/x'), 'bioregionalpassport.org')).toBe('http://localhost:3000');
    expect(platformOriginFor(new URL('http://boulder.bioregionalpassport.org/x'), 'BioregionalPassport.org')).toBe('https://bioregionalpassport.org');
    expect(platformOriginFor(new URL('https://passport.boulder.coop/x'), 'bioregionalpassport.org')).toBe('https://bioregionalpassport.org');
  });
  it('podSectionRedirectUrl strips an existing /p/<slug> prefix and keeps the query', () => {
    expect(podSectionRedirectUrl(new URL('https://passport.boulder.coop/grants?r=1'), 'boulder', 'bioregionalpassport.org')?.toString()).toBe(
      'https://bioregionalpassport.org/p/boulder/grants?r=1',
    );
    expect(podSectionRedirectUrl(new URL('https://boulder.bioregionalpassport.org/p/boulder/circulation'), 'boulder', 'bioregionalpassport.org')?.toString()).toBe(
      'https://bioregionalpassport.org/p/boulder/circulation',
    );
    expect(podSectionRedirectUrl(new URL('https://boulder.bioregionalpassport.org/events'), 'boulder', 'bioregionalpassport.org')).toBeNull();
    expect(podSectionRedirectUrl(new URL('https://boulder.bioregionalpassport.org/p/boulder'), 'boulder', 'bioregionalpassport.org')).toBeNull();
  });
});
