import { describe, expect, it, vi } from 'vitest';
import { ServiceError, type SessionClaims } from '@passport/service-kit';
import { checkAuth, matchPath, matchRoute, mountService, subPath, type MountDeps, type MountableRoute } from './mount';

const POD_DID = 'did:web:bioregionalpassport.org:dids:boulder';
const OTHER_DID = 'did:web:bioregionalpassport.org:dids:tenant-zero';
const OPERATOR = 'op-secret-0123456789';

// Fake sessions: the cookie value is a key into this table.
const SESSIONS: Record<string, SessionClaims> = {
  member: { subject: 'did:key:zMember', pod: POD_DID, tier: 'T1', authorities: ['event:attend'] },
  steward: { subject: 'did:key:zSteward', pod: POD_DID, tier: 'T3', authorities: ['pep:review', 'registry:propose', 'event:convene'] },
  elsewhere: { subject: 'did:key:zOther', pod: OTHER_DID, tier: 'T3', authorities: ['pep:review', 'registry:propose'] },
};

function fakeDeps(overrides: Partial<MountDeps> = {}): MountDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    platformDomain: 'bioregionalpassport.org',
    operatorToken: OPERATOR,
    secureCookies: true,
    masterKey: 'k'.repeat(64),
    findPod: async (slug) =>
      slug === 'boulder' ? { slug, did: POD_DID, manifest: { identity: { slug } }, policy: { version: 1 }, status: 'active' } : null,
    withPod: async (slug, fn) => {
      calls.push(`withPod:${slug}`);
      return fn({ scoped: slug });
    },
    platformDb: () => ({ platform: true }),
    readSession: async (token) => SESSIONS[token] ?? null,
    now: () => new Date('2026-09-22T00:00:00Z'),
    logError: () => {},
    ...overrides,
  };
}

const echo: MountableRoute['handler'] = async (ctx, req) => ({
  body: { slug: ctx.slug ?? null, podDid: ctx.podDid ?? null, db: ctx.db, params: req.params, query: req.query, body: req.body ?? null, subject: req.session?.subject ?? null },
});

const routes: MountableRoute[] = [
  { method: 'GET', path: '/open', auth: 'none', handler: echo },
  { method: 'GET', path: '/items/:id', handler: echo },
  { method: 'GET', path: '/items/special', handler: async () => ({ body: { special: true } }) },
  { method: 'POST', path: '/items/:id/notes/:note', auth: 'member', handler: echo },
  { method: 'GET', path: '/member', auth: 'member', handler: echo },
  { method: 'GET', path: '/flags', auth: 'authority:event:convene', handler: echo },
  { method: 'GET', path: '/steward', auth: 'steward', handler: echo },
  { method: 'POST', path: '/recompute', auth: 'operator', handler: echo },
  { method: 'POST', path: '/session', auth: 'none', handler: async () => ({ status: 201, body: { token: 'signed.session.token', subject: 'did:key:z' } }) },
  { method: 'POST', path: '/session/visitor', auth: 'none', handler: async () => ({ body: { token: 'visitor.token' } }) },
  { method: 'POST', path: '/other', auth: 'none', handler: async () => ({ body: { token: 'not-a-session' } }) },
  { method: 'GET', path: '/boom', handler: async () => { throw new Error('db password leaked in stack'); } },
  { method: 'GET', path: '/gate', handler: async () => { throw new ServiceError(403, 'NO_MEMBERSHIP', 'You are not a member of this pod yet.', 'Attend an event.'); } },
];

const BASE = 'https://boulder.bioregionalpassport.org/api/svc';

function call(svc: ReturnType<typeof mountService>, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, init: { cookie?: string; auth?: string; body?: unknown; headers?: Record<string, string>; url?: string } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.cookie) headers['cookie'] = `other=1; passport_session=${init.cookie}`;
  if (init.auth) headers['authorization'] = init.auth;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`${init.url ?? BASE}${path}`, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  return svc[method](req);
}

describe('route matching', () => {
  it('matches :param segments and decodes them', () => {
    expect(matchPath('/items/:id/notes/:note', '/items/a%20b/notes/7')).toEqual({ id: 'a b', note: '7' });
    expect(matchPath('/items/:id', '/items')).toBeNull();
    expect(matchPath('/items/:id', '/items/1/extra')).toBeNull();
    expect(matchPath('/', '/')).toEqual({});
  });
  it('prefers static segments over params and separates 404 from 405', () => {
    const r = matchRoute(routes, 'GET', '/items/special');
    expect(r.kind === 'match' && r.route.path).toBe('/items/special');
    expect(matchRoute(routes, 'DELETE', '/items/1')).toEqual({ kind: 'method-not-allowed', allowed: ['GET'] });
    expect(matchRoute(routes, 'GET', '/nope').kind).toBe('not-found');
  });
  it('strips the mount base', () => {
    expect(subPath('/api/index/me/explanation', '/api/index')).toBe('/me/explanation');
    expect(subPath('/api/index', '/api/index')).toBe('/');
    expect(subPath('/api/index/', '/api/index')).toBe('/');
  });
});

describe('mountService (pod scope)', () => {
  const deps = fakeDeps();
  const svc = mountService(routes, { base: '/api/svc', scope: 'pod' }, deps);

  it('dispatches with params, query and a PodContext built inside withPod', async () => {
    const res = await call(svc, 'GET', '/items/42?x=1&x=2&y=z');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ slug: 'boulder', podDid: POD_DID, db: { scoped: 'boulder' }, params: { id: '42' }, query: { x: '1', y: 'z' } });
    expect(deps.calls).toContain('withPod:boulder');
  });

  it('parses JSON bodies and rejects malformed JSON', async () => {
    const ok = await call(svc, 'POST', '/items/1/notes/2', { cookie: 'member', body: { a: 1 } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).body).toEqual({ a: 1 });
    const bad = await svc.POST(new Request(`${BASE}/items/1/notes/2`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'passport_session=member' }, body: '{nope' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('BAD_JSON');
  });

  it('returns 404 POD_NOT_FOUND for an unknown pod, and when no pod is named', async () => {
    const unknown = await call(svc, 'GET', '/open', { url: 'https://nowhere.bioregionalpassport.org/api/svc' });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).code).toBe('POD_NOT_FOUND');
    const none = await call(svc, 'GET', '/open', { url: 'https://bioregionalpassport.org/api/svc' });
    expect((await none.json()).code).toBe('POD_NOT_FOUND');
    const viaHeader = await call(svc, 'GET', '/open', { url: 'https://bioregionalpassport.org/api/svc', headers: { 'x-pod': 'boulder' } });
    expect(viaHeader.status).toBe(200);
  });

  it('returns 404 NOT_FOUND and 405 METHOD_NOT_ALLOWED', async () => {
    expect((await call(svc, 'GET', '/missing')).status).toBe(404);
    const r = await call(svc, 'PUT', '/open');
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET');
  });

  describe('auth gating', () => {
    it('none: open to anyone, session passed through when present', async () => {
      expect((await call(svc, 'GET', '/open')).status).toBe(200);
      expect((await (await call(svc, 'GET', '/open', { cookie: 'member' })).json()).subject).toBe('did:key:zMember');
    });
    it('member: needs a session issued by this pod', async () => {
      expect((await call(svc, 'GET', '/member')).status).toBe(401);
      expect((await call(svc, 'GET', '/member', { cookie: 'forged' })).status).toBe(401);
      const other = await call(svc, 'GET', '/member', { cookie: 'elsewhere' });
      expect(other.status).toBe(403);
      expect((await other.json()).code).toBe('POD_MISMATCH');
      expect((await call(svc, 'GET', '/member', { cookie: 'member' })).status).toBe(200);
    });
    it('authority:<scope>: needs the scope in session.authorities', async () => {
      expect((await call(svc, 'GET', '/flags')).status).toBe(401);
      const r = await call(svc, 'GET', '/flags', { cookie: 'member' });
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ code: 'MISSING_AUTHORITY', message: expect.stringContaining('event:convene') });
      expect((await call(svc, 'GET', '/flags', { cookie: 'steward' })).status).toBe(200);
    });
    it('steward: means authority:pep:review', async () => {
      expect((await call(svc, 'GET', '/steward', { cookie: 'member' })).status).toBe(403);
      expect((await call(svc, 'GET', '/steward', { cookie: 'steward' })).status).toBe(200);
      expect((await call(svc, 'GET', '/steward', { cookie: 'elsewhere' })).status).toBe(403);
    });
    it('operator: Bearer OPERATOR_TOKEN or a registry:propose session', async () => {
      expect((await call(svc, 'POST', '/recompute')).status).toBe(401);
      expect((await call(svc, 'POST', '/recompute', { auth: 'Bearer wrong' })).status).toBe(403);
      expect((await call(svc, 'POST', '/recompute', { auth: `Bearer ${OPERATOR}` })).status).toBe(200);
      expect((await call(svc, 'POST', '/recompute', { cookie: 'member' })).status).toBe(403);
      expect((await call(svc, 'POST', '/recompute', { cookie: 'steward' })).status).toBe(200);
    });
    it('operator: a Bearer token is refused when no OPERATOR_TOKEN is configured', async () => {
      const noToken = mountService(routes, { base: '/api/svc', scope: 'pod' }, fakeDeps({ operatorToken: undefined }));
      expect((await call(noToken, 'POST', '/recompute', { auth: 'Bearer ' })).status).toBe(401);
      expect((await call(noToken, 'POST', '/recompute', { auth: 'Bearer anything' })).status).toBe(403);
    });
    it('checkAuth rejects unknown auth values', () => {
      expect(() => checkAuth('bogus' as never, { session: null, bearerToken: null })).toThrow(/Unknown route auth/);
    });
  });

  describe('error mapping', () => {
    it('maps ServiceError to its status and {code,message,hint}', async () => {
      const r = await call(svc, 'GET', '/gate');
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ code: 'NO_MEMBERSHIP', message: 'You are not a member of this pod yet.', hint: 'Attend an event.' });
    });
    it('maps unknown errors to an opaque 500 INTERNAL and logs them', async () => {
      const logError = vi.fn();
      const s = mountService(routes, { base: '/api/svc', scope: 'pod' }, fakeDeps({ logError }));
      const r = await call(s, 'GET', '/boom');
      expect(r.status).toBe(500);
      const body = await r.json();
      expect(body.code).toBe('INTERNAL');
      expect(JSON.stringify(body)).not.toContain('password');
      expect(logError).toHaveBeenCalledOnce();
    });
  });

  describe('session cookie', () => {
    it('sets passport_session when POST /session returns a token', async () => {
      const r = await call(svc, 'POST', '/session', { body: {} });
      expect(r.status).toBe(201);
      const cookie = r.headers.get('set-cookie') ?? '';
      expect(cookie).toContain('passport_session=signed.session.token');
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).toMatch(/Max-Age=3600/);
    });
    it('also sets it for POST /session/visitor, and never for other paths', async () => {
      expect((await call(svc, 'POST', '/session/visitor', { body: {} })).headers.get('set-cookie')).toContain('passport_session=visitor.token');
      expect((await call(svc, 'POST', '/other', { body: {} })).headers.get('set-cookie')).toBeNull();
    });
    it('DELETE /session clears the cookie when the mount has a session endpoint', async () => {
      const vta = mountService([], { base: '/api/svc', scope: 'pod', sessionEndpoint: true }, fakeDeps());
      const r = await call(vta, 'DELETE', '/session');
      expect(r.status).toBe(200);
      expect(r.headers.get('set-cookie')).toMatch(/passport_session=;.*Max-Age=0/);
      // Without the session endpoint, DELETE falls through to the route table (POST-only here).
      expect((await call(svc, 'DELETE', '/session')).status).toBe(405);
    });
  });
});

describe('mountService (platform scope)', () => {
  it('builds a PlatformContext without opening withPod', async () => {
    const deps = fakeDeps();
    const handler = vi.fn(async (ctx: any) => ({ body: { domain: ctx.platformDomain, hasKey: Boolean(ctx.masterKey), db: ctx.db } }));
    const svc = mountService([{ method: 'GET', path: '/pods', auth: 'none', handler }], { base: '/api/registry', scope: 'platform' }, deps);
    const r = await svc.GET(new Request('https://bioregionalpassport.org/api/registry/pods'));
    expect(await r.json()).toEqual({ domain: 'bioregionalpassport.org', hasKey: true, db: { platform: true } });
    expect(deps.calls).toEqual([]);
  });
  it('operator routes accept any registry:propose session (no pod binding)', async () => {
    const svc = mountService([{ method: 'POST', path: '/pods', auth: 'operator', handler: async () => ({ status: 201, body: {} }) }], { base: '/api/control', scope: 'platform' }, fakeDeps());
    const r = await svc.POST(new Request('https://bioregionalpassport.org/api/control/pods', { method: 'POST', headers: { cookie: 'passport_session=elsewhere' } }));
    expect(r.status).toBe(201);
  });
});
