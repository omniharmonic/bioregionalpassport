/**
 * Mounts for the circulation services (`/api/gateway`, `/api/pos`). Both route tables close over one pod's
 * signer (payment requests, receipts and merchant authority credentials are signed as the pod), so — like the
 * VTA mount in `./services` — a mount is built per pod on first use and rebuilt when the cached signer (60 s,
 * see `./pod`) is refreshed.
 */
import 'server-only';
import { createGatewayRoutes } from '@passport/cc-gateway';
import type { PodSigner } from '@passport/control-plane';
import { digestMultibase, type DidResolver } from '@passport/credential-core';
import { withPod } from '@passport/db';
import { VAC_STATUS_LIST, statusListCredential, statusListUrl } from '@passport/pod-vta';
import { createPosAdapterRoutes } from '@passport/pos-adapter';
import type { StatusFetch } from '@passport/verifier-sdk';
import { db } from './db';
import { env } from './env';
import { MountError, errorToResponse, mountService, type MountableRoute, type MountedService, type MountOptions } from './mount';
import { findPod, loadPodSigner, type LoadedPod } from './pod';
import { platformResolver } from './services';
import { resolveSlug } from './tenant';

let resolver: DidResolver | undefined;
/** The platform DID resolver (pod DIDs from the database, did:web fetch, inline did:key), built once. */
export function gatewayResolver(): DidResolver {
  resolver ??= platformResolver();
  return resolver;
}

type VtaCtx = Parameters<typeof statusListUrl>[0];

/**
 * Status-list fetcher for `/pay/authorize`: this pod's VAC revocation list, read straight from pod-vta (same
 * approach as the round runtime) instead of an HTTP round trip to ourselves. Other lists are not trusted here.
 */
export function podStatusFetch(pod: LoadedPod, signer: PodSigner): StatusFetch {
  const platformDomain = env().PLATFORM_DOMAIN;
  return (url) =>
    withPod(db(), pod.slug, async (tx) => {
      const ctx = { slug: pod.slug, podDid: pod.did, db: tx, manifest: pod.manifest, policy: pod.policy, now: () => new Date(), platformDomain } as unknown as VtaCtx;
      if (url !== statusListUrl(ctx)) throw new Error(`Unknown status list ${url}`);
      return statusListCredential(ctx, { podSigner: signer }, VAC_STATUS_LIST);
    });
}

/** The dependencies the gateway needs for one pod. */
export async function gatewayDepsFor(pod: LoadedPod): Promise<{ resolver: DidResolver; podSigner: PodSigner; statusFetch: StatusFetch }> {
  const podSigner = await loadPodSigner(pod.slug);
  return { resolver: gatewayResolver(), podSigner, statusFetch: podStatusFetch(pod, podSigner) };
}

/** A pod-scoped mount whose route table is built from the pod's signer. */
function perPodService(opts: MountOptions, build: (deps: Awaited<ReturnType<typeof gatewayDepsFor>>) => MountableRoute[]): MountedService {
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
      const deps = await gatewayDepsFor(pod);
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

/**
 * POS adapter (`/api/pos`, pod scope), with the pod signer so tender write-back re-signs the receipt, and
 * `digestMultibase` so staff can record tenders with their `staffVac`.
 */
export const posService = perPodService({ base: '/api/pos', scope: 'pod' }, ({ podSigner }) => createPosAdapterRoutes({ podSigner, digest: digestMultibase }) as MountableRoute[]);
