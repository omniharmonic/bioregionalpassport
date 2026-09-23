/**
 * Test harness: the real pod VTA and trust-index route tables on PGlite, reachable through a `fetch` that
 * behaves like apps/web's mount (per-client cookie jar for `passport_session`). Proves the wallet's payloads
 * against the real server code.
 */
import { createResolver, didWebDocument, generateKeyPair, keyPairForDid, signDocument, type KeyPair } from '@passport/credential-core';
import { createTestDb, createTestPod, withPod, type Db } from '@passport/db';
import { bootstrapSteward, createPodVtaRoutes, MemoryChallengeStore, RelayStore, type PodSigner, type PodVtaDeps, type VtaContext, type VtaRoute } from '@passport/pod-vta';
import { errorResult, type SessionClaims } from '@passport/service-kit';
import { boulderManifest, defaultTrustPolicy, type TrustPolicy } from '@passport/tenant-config';
import { createTrustIndexRoutes, ensureIndexTables, recommendTier } from '@passport/trust-index';
import { readSession } from '@passport/verifier-sdk';
import type { FetchLike } from '../outbox.js';

export const SLUG = 'boulder';
export const DOMAIN = 'bioregionalpassport.org';
export const POD_DID = boulderManifest.identity.did;
export const SECRET = 'pod-client-test-session-secret-at-least-32-bytes';

type AnyRoute = { method: string; path: string; handler: (ctx: any, req: any) => Promise<{ status?: number; body: any }> };

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(':')) params[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export interface Harness {
  db: Db;
  deps: PodVtaDeps;
  vta: VtaRoute[];
  index: AnyRoute[];
  podKey: KeyPair;
  run<T>(fn: (ctx: VtaContext) => Promise<T>): Promise<T>;
  /** Calls one route like the mount does; errors become `{ code, message }` bodies. */
  callRoute(routes: AnyRoute[], method: string, pathWithQuery: string, body?: unknown, session?: SessionClaims): Promise<{ status: number; body: any }>;
  /** A fetch with its own cookie jar (one per simulated phone). */
  fetchFor(jar?: CookieJar): FetchLike & { jar: CookieJar };
  close(): Promise<void>;
}

export interface CookieJar {
  session?: SessionClaims;
}

export async function createHarness(opts: { policy?: TrustPolicy } = {}): Promise<Harness> {
  const db = await createTestDb();
  await createTestPod(db, SLUG);
  await withPod(db, SLUG, (tx) => ensureIndexTables(tx));
  const podKey = keyPairForDid(POD_DID, generateKeyPair().privateKey);
  const podSigner: PodSigner = { did: podKey.did, kid: podKey.kid, keyPair: podKey, sign: (doc, opts) => signDocument(doc, podKey, opts) };
  const resolver = createResolver({ staticDocs: { [POD_DID]: didWebDocument(POD_DID, podKey.publicKeyMultibase) } });
  const deps: PodVtaDeps = {
    podSigner,
    resolver,
    sessionSecret: SECRET,
    index: { recommendTier: (ctx, did) => recommendTier(ctx, did) },
    challenges: new MemoryChallengeStore(),
    relay: new RelayStore(),
  };
  const vta = createPodVtaRoutes(deps);
  const index = createTrustIndexRoutes({ resolver }) as unknown as AnyRoute[];
  const policy = opts.policy ?? defaultTrustPolicy(POD_DID);
  const ctxFor = (tx: Db): VtaContext => ({ slug: SLUG, podDid: POD_DID, db: tx, manifest: boulderManifest, policy, now: () => new Date(), platformDomain: DOMAIN });
  const run = <T>(fn: (ctx: VtaContext) => Promise<T>) => withPod(db, SLUG, (tx) => fn(ctxFor(tx)));

  const callRoute: Harness['callRoute'] = async (routes, method, pathWithQuery, body, session) => {
    const [path, qs] = pathWithQuery.split('?') as [string, string | undefined];
    for (const r of routes) {
      const params = r.method === method ? match(r.path, path) : null;
      if (!params) continue;
      const req = { params, query: Object.fromEntries(new URLSearchParams(qs ?? '')), body, ...(session ? { session } : {}) };
      return run(async (ctx) => {
        try {
          const out = await r.handler(ctx, req);
          return { status: out.status ?? 200, body: out.body };
        } catch (e) {
          if (!(e instanceof Error) || e.name !== 'ServiceError') throw e;
          return errorResult(e);
        }
      });
    }
    return { status: 404, body: { code: 'NOT_FOUND', message: `There is nothing at ${method} ${path}.` } };
  };

  const fetchFor = (jar: CookieJar = {}) => {
    const f = (async (input: string, init?: RequestInit) => {
      const url = new URL(String(input), `https://${SLUG}.${DOMAIN}`);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
      const [, api, service, ...rest] = url.pathname.split('/');
      if (api !== 'api') throw new Error(`unexpected url ${input}`);
      const sub = `/${rest.join('/')}${url.search}`;
      let res: { status: number; body: any };
      if (service === 'vta' && method === 'DELETE' && sub === '/session') {
        delete jar.session;
        res = { status: 200, body: { ok: true } };
      } else if (service === 'vta') {
        res = await callRoute(vta as unknown as AnyRoute[], method, sub, body, jar.session);
        if (method === 'POST' && (sub === '/session' || sub === '/session/visitor') && res.status === 200) {
          const raw = await readSession(res.body.token, SECRET);
          if (raw) jar.session = { subject: raw.subject, pod: raw.pod ?? '', authorities: raw.authorities ?? [], ...(raw.tier ? { tier: raw.tier } : {}) };
        }
      } else if (service === 'index') {
        res = await callRoute(index, method, sub, body, jar.session);
      } else {
        res = { status: 404, body: { code: 'NOT_FOUND', message: 'That service is not in the test harness.' } };
      }
      return new Response(res.status === 204 ? null : JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
    }) as FetchLike & { jar: CookieJar };
    f.jar = jar;
    return f;
  };

  return {
    db,
    deps,
    vta,
    index,
    podKey,
    run,
    callRoute,
    fetchFor,
    close: () => db.close(),
  };
}

/** Operator bootstrap of a first steward (T3: event:convene, vwc:issue, …), as the control plane does. */
export async function bootstrapConvener(h: Harness, did: string) {
  return h.run((ctx) => bootstrapSteward(ctx, h.deps, did));
}
