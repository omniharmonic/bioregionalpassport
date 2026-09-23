/**
 * Real dependencies for the round service mount: a DID resolver that resolves pod DIDs hosted on this
 * platform from the database (`platformResolver` from `lib/services.ts`), inline did:key, and the pod's own
 * authority-credential status list (served by pod-vta) so a revoked group authority is refused.
 * Everything is built lazily so `next build` never needs the environment.
 */
import 'server-only';
import type { DidDocument, DidResolver } from '@passport/credential-core';
import { VAC_STATUS_LIST, statusListCredential, statusListUrl } from '@passport/pod-vta';
import type { RoundContext, RoundDeps } from '@passport/round';
import { loadPodSigner } from '@/lib/pod';
import { platformResolver } from '@/lib/services';
import { mountRound } from './mount';

let resolver: DidResolver | undefined;
const lazyResolver: DidResolver = {
  resolve: (did: string): Promise<DidDocument> => (resolver ??= platformResolver()).resolve(did),
};

async function statusFetch(url: string, ctx: RoundContext): Promise<unknown> {
  // pod-vta's context is the same PodContext shape; only its own VAC list is known here.
  const vtaCtx = ctx as unknown as Parameters<typeof statusListUrl>[0];
  if (url !== statusListUrl(vtaCtx)) throw new Error(`Unknown status list ${url}`);
  return statusListCredential(vtaCtx, { podSigner: await loadPodSigner(ctx.slug) }, VAC_STATUS_LIST);
}

export const roundDeps: RoundDeps = { resolver: lazyResolver, statusFetch };

/** Grants rounds (pod scope). */
export const roundService = mountRound(roundDeps);
