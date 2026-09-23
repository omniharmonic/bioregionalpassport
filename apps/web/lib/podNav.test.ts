import { describe, expect, it } from 'vitest';
import { boulderManifest } from '@passport/tenant-config';
import { isStewardSession, podLinks } from './podNav';

const POD = boulderManifest.identity.did;

describe('podLinks', () => {
  it('links the Passport to /wallet?pod=<slug> on both hosts', () => {
    for (const base of ['', '/p/boulder']) {
      expect(podLinks(boulderManifest, base).find((l) => l.key === 'passport')?.href).toBe('/wallet?pod=boulder');
    }
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
