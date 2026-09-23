import { describe, expect, it } from 'vitest';
import { boulderManifest } from '@passport/tenant-config';
import { isStewardSession, platformSectionHref, podLinks } from './podNav';

const POD = boulderManifest.identity.did;

describe('podLinks', () => {
  it('links the Passport to /wallet?pod=<slug> on both hosts', () => {
    for (const base of ['', '/p/boulder']) {
      expect(podLinks(boulderManifest, base).find((l) => l.key === 'passport')?.href).toBe('/wallet?pod=boulder');
    }
  });
  it('points Grants, Credits and Merchant at the platform origin on a pod host', () => {
    const onPod = podLinks(boulderManifest, '', { platformOrigin: 'https://bioregionalpassport.org' });
    const href = (key: string) => onPod.find((l) => l.key === key)?.href;
    for (const [key, section] of [['grants', 'grants'], ['credits', 'circulation'], ['merchant', 'merchant']] as const) {
      expect(href(key)).toBe(`https://bioregionalpassport.org/p/boulder/${section}`);
    }
    expect(href('events')).toBe('/events');
    expect(href('governance')).toBe('/governance');
    const onPlatform = podLinks(boulderManifest, '/p/boulder', { platformOrigin: 'https://bioregionalpassport.org' });
    expect(onPlatform.find((l) => l.key === 'grants')?.href).toBe('/p/boulder/grants');
  });
  it('platformSectionHref falls back to the pod-host path (proxy-redirected) without an origin', () => {
    expect(platformSectionHref('boulder', '', 'grants')).toBe('/grants');
    expect(platformSectionHref('boulder', '', 'merchant', 'http://localhost:3000/')).toBe('http://localhost:3000/p/boulder/merchant');
    expect(platformSectionHref('boulder', '/p/boulder', 'circulation', 'https://x.org')).toBe('/p/boulder/circulation');
  });
  it('adds Steward only when asked', () => {
    expect(podLinks(boulderManifest, '/p/boulder').some((l) => l.key === 'steward')).toBe(false);
    expect(podLinks(boulderManifest, '/p/boulder', { steward: true }).find((l) => l.key === 'steward')?.href).toBe('/p/boulder/steward');
    expect(podLinks(boulderManifest, '', { steward: true }).find((l) => l.key === 'steward')?.href).toBe('/steward');
  });
});

describe('isStewardSession', () => {
  it('needs pep:review from this pod', () => {
    expect(isStewardSession({ pod: POD, authorities: ['pep:review'] }, POD)).toBe(true);
    expect(isStewardSession({ pod: POD, authorities: ['round:vote'] }, POD)).toBe(false);
    expect(isStewardSession({ pod: 'did:web:elsewhere', authorities: ['pep:review'] }, POD)).toBe(false);
    expect(isStewardSession(null, POD)).toBe(false);
  });
});
