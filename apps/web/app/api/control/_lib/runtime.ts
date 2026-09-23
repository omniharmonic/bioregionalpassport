/** Real dependencies for the first-steward bootstrap route (built lazily so `next build` needs no environment). */
import 'server-only';
import { withPod } from '@passport/db';
import { db } from '@/lib/db';
import { findPod, invalidatePod, loadPodSigner } from '@/lib/pod';
import { mountBootstrapSteward } from './bootstrapSteward';

export const bootstrapStewardService = mountBootstrapSteward({
  findPod: async (slug) => {
    // Always read the pod fresh: the operator may have just provisioned or edited it.
    invalidatePod(slug);
    return findPod(slug);
  },
  withPod: (slug, fn) => withPod(db(), slug, fn),
  loadSigner: (slug) => loadPodSigner(slug),
});
