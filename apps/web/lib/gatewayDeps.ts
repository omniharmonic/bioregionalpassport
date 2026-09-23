/**
 * Mounts for the circulation services (`/api/gateway`, `/api/pos`). Both route tables close over one pod's
 * signer (payment requests, receipts and merchant authority credentials are signed as the pod), so — like the
 * VTA mount in `./services` — a mount is built per pod on first use and rebuilt when the cached signer (60 s,
 * see `./pod`) is refreshed.
 */
import 'server-only';
import { createGatewayRoutes } from '@passport/cc-gateway';
import { didDocumentFor, type PodSigner } from '@passport/control-plane';
import { createResolver, type DidResolver } from '@passport/credential-core';
import { createPosAdapterRoutes } from '@passport/pos-adapter';
import { db } from './db';
import { env } from './env';
import { MountError, errorToResponse, mountService, type MountableRoute, type MountedService, type MountOptions } from './mount';
import { findPod, loadPodSigner } from './pod';
import { resolveSlug } from './tenant';

/**
 * DID resolver for presentations and signed messages, built the same way as the VTA's in `./services`: pod
 * DIDs hosted on this platform resolve from the database; everything else via did:web fetch and inline did:key.
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
export function gatewayResolver(): DidResolver {
  resolver ??= platformResolver();
  return resolver;
}

/** The dependencies the gateway needs for one pod: `{ resolver, podSigner }`. */
export async function gatewayDepsFor(slug: string): Promise<{ resolver: DidResolver; podSigner: PodSigner }> {
  return { resolver: gatewayResolver(), podSigner: await loadPodSigner(slug) };
}

/** A pod-scoped mount whose route table is built from the pod's signer. */
function perPodService(opts: MountOptions, build: (deps: { resolver: DidResolver; podSigner: PodSigner }) => MountableRoute[]): MountedService {
  const mounts = new Map<string, { signer: PodSigner; service: MountedService }>();
  const handle = async (req: Request): Promise<Response> => {
    const method = req.method.toUpperCase() as keyof MountedService;
    try {
      const e = env();
      const slug = resolveSlug(req, { platformDomain: e.PLATFORM_DOMAIN, customDomains: e.POD_CUSTOM_DOMAINS });
      if (!slug) {
        throw new MountError(404, 'POD_NOT_FOUND', 'This request does not name a pod.', 'Use a pod address such as boulder.<domain>, or send an X-Pod header.');
      }
      const pod = await findPod(slug);
      if (!pod || pod.status !== 'active') throw new MountError(404, 'POD_NOT_FOUND', `No active pod is registered as ${slug}.`);
      if (!pod.manifest.modules.circulation) {
        throw new MountError(404, 'MODULE_OFF', `${pod.manifest.identity.name} has not turned on local credits.`);
      }
      const deps = await gatewayDepsFor(slug);
      let hit = mounts.get(slug);
      if (!hit || hit.signer !== deps.podSigner) {
        hit = { signer: deps.podSigner, service: mountService(build(deps), opts) };
        mounts.set(slug, hit);
      }
      return hit.service[method](req);
    } catch (err) {
      return errorToResponse(err, undefined, `api ${opts.base}`);
    }
  };
  return { GET: handle, POST: handle, PUT: handle, DELETE: handle };
}

/** Mutual-credit gateway (`/api/gateway`, pod scope). */
export const gatewayService = perPodService({ base: '/api/gateway', scope: 'pod' }, (deps) => createGatewayRoutes(deps) as MountableRoute[]);

/** POS adapter (`/api/pos`, pod scope), with the pod signer so tender write-back re-signs the receipt. */
export const posService = perPodService({ base: '/api/pos', scope: 'pod' }, ({ podSigner }) => createPosAdapterRoutes({ podSigner }) as MountableRoute[]);
