/**
 * Real dependencies for the round service mount: a DID resolver that resolves pod DIDs hosted on this
 * platform from the database (same approach as `lib/services.ts`), inline did:key, and the pod's own
 * authority-credential status list (served by pod-vta) so a revoked group authority is refused.
 * Everything is built lazily so `next build` never needs the environment.
 */
import 'server-only';
import { didDocumentFor } from '@passport/control-plane';
import { createResolver, type DidDocument, type DidResolver } from '@passport/credential-core';
import { VAC_STATUS_LIST, statusListCredential, statusListUrl } from '@passport/pod-vta';
import type { RoundContext, RoundDeps } from '@passport/round';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { loadPodSigner } from '@/lib/pod';
import { mountRound } from './mount';

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
