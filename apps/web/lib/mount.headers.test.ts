import { describe, expect, it } from 'vitest';
import type { SessionClaims } from '@passport/service-kit';
import { mountService, respond, type MountDeps, type MountableRoute } from './mount';

const POD_DID = 'did:web:bioregionalpassport.org:dids:boulder';
const STEWARD: SessionClaims = { subject: 'did:key:zSteward', pod: POD_DID, tier: 'T3', authorities: ['pep:review'] };

const deps: MountDeps = {
  platformDomain: 'bioregionalpassport.org',
  secureCookies: true,
  findPod: async (slug) => (slug === 'boulder' ? { slug, did: POD_DID, manifest: {}, policy: { version: 1 }, status: 'active' } : null),
  withPod: async (_slug, fn) => fn({}),
  platformDb: () => ({}),
  readSession: async (token) => (token === 'steward' ? STEWARD : null),
  logError: () => {},
};

const CSV = 'id,createdAt,payer\n1,2026-09-22T00:00:00.000Z,"did:key:z,1"\n';

const routes: MountableRoute[] = [
  {
    method: 'GET',
    path: '/exports/transactions.csv',
    auth: 'steward',
    handler: async (ctx) => ({
      body: CSV,
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${ctx.slug}-transactions.csv"` },
    }),
  },
  { method: 'GET', path: '/json-with-headers', auth: 'none', handler: async () => ({ status: 201, body: { ok: true }, headers: { 'x-extra': 'yes', 'content-type': 'text/plain' } }) },
  { method: 'GET', path: '/string-no-type', auth: 'none', handler: async () => ({ body: 'plain words' }) },
];

const svc = mountService(routes, { base: '/api/gateway', scope: 'pod' }, deps);
const get = (path: string, cookie?: string) =>
  svc.GET(new Request(`https://boulder.bioregionalpassport.org/api/gateway${path}`, { headers: cookie ? { cookie: `passport_session=${cookie}` } : {} }));

describe('mount: RouteResult.headers and string bodies', () => {
  it('sends a string body with a non-JSON content type verbatim, with the handler headers', async () => {
    const res = await get('/exports/transactions.csv', 'steward');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="boulder-transactions.csv"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe(CSV);
  });

  it('still enforces auth before the raw body is sent', async () => {
    const res = await get('/exports/transactions.csv');
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('UNAUTHENTICATED');
  });

  it('keeps JSON for object bodies, adding extra headers but never overriding the JSON content type', async () => {
    const res = await get('/json-with-headers');
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('x-extra')).toBe('yes');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('JSON-encodes a string body when no content type is given (previous behaviour)', async () => {
    const res = await get('/string-no-type');
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toBe('plain words');
  });

  it('respond() treats a JSON content type on a string body as JSON', async () => {
    const res = respond(200, 'x', { 'content-type': 'application/json' });
    expect(await res.text()).toBe('"x"');
  });
});
