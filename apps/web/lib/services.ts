/**
 * Service mounts (ADR-26: one deployable, every service under `/api/<service>`).
 * Each `app/api/<service>/[[...path]]/route.ts` re-exports one of these.
 */
import * as appview from '@passport/appview';
import { createControlRoutes, createRegistryRoutes, didDocumentFor, type PodSigner } from '@passport/control-plane';
import { createResolver, type DidResolver } from '@passport/credential-core';
import type { Db } from '@passport/db';
import * as podVta from '@passport/pod-vta';
import { createTrustIndexRoutes, ensureIndexTables, markWeighted, recommendTier } from '@passport/trust-index';
import { db } from './db';
import { env } from './env';
import { MountError, errorToResponse, mountService, subPath, type MountableRoute, type MountedService } from './mount';
import { findPod, loadPodSigner } from './pod';
import { resolveSlug } from './tenant';

/** Platform TRQP registry (no pod scope). */
export const registryService = mountService(createRegistryRoutes() as MountableRoute[], { base: '/api/registry', scope: 'platform' });

/**
 * Operator control plane: provision / manifest / verify / export (no pod scope).
 * Same optional deps as the `passport` CLI: the AppView demo seeder on
 * provision, and the VTA/AppView smoke hooks for verify.
 * TODO(Task 14): add `gateway: @passport/cc-gateway` to verifyDeps once it lands.
 */
export const controlService = mountService(
  createControlRoutes({
    provisionDeps: { seedRecords: appview.seedDemoRecords },
    verifyDeps: { vta: podVta, appview },
  }) as MountableRoute[],
  { base: '/api/control', scope: 'platform' },
);

/** Trust index (pod scope); its side tables are ensured inside the pod transaction. */
export const indexService = mountService(createTrustIndexRoutes() as MountableRoute[], {
  base: '/api/index',
  scope: 'pod',
  prepare: (db) => ensureIndexTables(db),
});

/** Open-records AppView (pod scope). */
export const appviewService = mountService(appview.createAppviewRoutes() as MountableRoute[], { base: '/api/appview', scope: 'pod' });

/**
 * Pod VTA (pod scope). Its route table closes over one pod's signer, so a
 * mount is built per pod on first use and rebuilt when the cached signer
 * (60 s, see `lib/pod.ts`) is refreshed. `DELETE /api/vta/session` (sign out)
 * is handled by the mount itself.
 */
const VTA_OPTS = {
  base: '/api/vta',
  scope: 'pod' as const,
  sessionEndpoint: true,
  prepare: (tx: Db) => ensureIndexTables(tx),
};

/** Mount with no routes: answers sign-out without loading any pod. */
const vtaFallback = mountService([], VTA_OPTS);

const vtaMounts = new Map<string, { signer: PodSigner; service: MountedService }>();

/**
 * DID resolver for presentations. Pod DIDs hosted on this platform resolve
 * from the database (no HTTP round trip to ourselves); everything else via
 * the default did:web fetch and inline did:key.
 */
function platformResolver(): DidResolver {
  const { PLATFORM_DOMAIN } = env();
  const local = new RegExp(`^https://${PLATFORM_DOMAIN.replace(/\./g, '\\.')}/dids/([a-z0-9-]{2,40})/did\\.json$`);
  return createResolver({
    webFetch: async (url) => {
      const m = local.exec(url);
      if (m?.[1]) {
        const doc = await didDocumentFor(db(), m[1], PLATFORM_DOMAIN);
        if (!doc) throw new Error(`No pod DID is hosted for ${m[1]}.`);
        return doc;
      }
      const res = await fetch(url, { headers: { accept: 'application/did+json, application/json' } });
      if (!res.ok) throw new Error(`Could not resolve ${url} (${res.status}).`);
      return res.json();
    },
  });
}

let resolver: DidResolver | undefined;

async function vtaFor(slug: string): Promise<MountedService> {
  const signer = await loadPodSigner(slug);
  const hit = vtaMounts.get(slug);
  if (hit && hit.signer === signer) return hit.service;
  resolver ??= platformResolver();
  const routes = podVta.createPodVtaRoutes({
    podSigner: signer,
    resolver,
    sessionSecret: env().SESSION_SECRET,
    platformDb: db(),
    index: {
      recommendTier: (ctx, did) => recommendTier(ctx, did),
      markWeighted: (ctx, poster, commitments, weighted) => markWeighted(ctx, poster, commitments, weighted),
    },
  });
  const service = mountService(routes as MountableRoute[], VTA_OPTS);
  vtaMounts.set(slug, { signer, service });
  return service;
}

async function vtaHandle(req: Request): Promise<Response> {
  const method = req.method.toUpperCase() as keyof MountedService;
  // Sign-out never needs the pod or its key.
  if (method === 'DELETE' && subPath(new URL(req.url).pathname, VTA_OPTS.base).replace(/\/+$/, '') === '/session') {
    return vtaFallback.DELETE(req);
  }
  try {
    const e = env();
    const slug = resolveSlug(req, { platformDomain: e.PLATFORM_DOMAIN, customDomains: e.POD_CUSTOM_DOMAINS });
    if (!slug) {
      throw new MountError(404, 'POD_NOT_FOUND', 'This request does not name a pod.', 'Use a pod address such as boulder.<domain>, or send an X-Pod header.');
    }
    const pod = await findPod(slug);
    if (!pod || pod.status !== 'active') throw new MountError(404, 'POD_NOT_FOUND', `No active pod is registered as ${slug}.`);
    const service = await vtaFor(slug);
    return service[method](req);
  } catch (err) {
    return errorToResponse(err, undefined, 'api /api/vta');
  }
}

export const vtaService: MountedService = { GET: vtaHandle, POST: vtaHandle, PUT: vtaHandle, DELETE: vtaHandle };
