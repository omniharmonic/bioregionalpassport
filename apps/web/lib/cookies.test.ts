import { describe, expect, it } from 'vitest';
import { clearSessionCookieHeaders, sessionCookieDomain, sessionCookieHeader } from './cookies';

describe('sessionCookieDomain', () => {
  it('is the platform domain on the platform host and its sub-domains', () => {
    expect(sessionCookieDomain('bioregionalpassport.org', 'bioregionalpassport.org')).toBe('bioregionalpassport.org');
    expect(sessionCookieDomain('Boulder.BioregionalPassport.org:443', 'bioregionalpassport.org')).toBe('bioregionalpassport.org');
    expect(sessionCookieDomain('www.bioregionalpassport.org', 'bioregionalpassport.org')).toBe('bioregionalpassport.org');
  });
  it('is host-only (undefined) on localhost, custom domains and look-alikes', () => {
    expect(sessionCookieDomain('localhost:3000', 'bioregionalpassport.org')).toBeUndefined();
    expect(sessionCookieDomain('boulder.localhost:3000', 'localhost')).toBeUndefined();
    expect(sessionCookieDomain('passport.boulder.coop', 'bioregionalpassport.org')).toBeUndefined();
    expect(sessionCookieDomain('evilbioregionalpassport.org', 'bioregionalpassport.org')).toBeUndefined();
    expect(sessionCookieDomain(null, 'bioregionalpassport.org')).toBeUndefined();
  });
  it('adds Domain to the set and clear headers', () => {
    expect(sessionCookieHeader('t', true, 'bioregionalpassport.org')).toBe(
      'passport_session=t; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax; Domain=bioregionalpassport.org; Secure',
    );
    expect(sessionCookieHeader('t', false)).not.toMatch(/Domain/);
    expect(clearSessionCookieHeaders(false)).toHaveLength(1);
    expect(clearSessionCookieHeaders(false, 'bioregionalpassport.org')).toHaveLength(2);
  });
});
