/**
 * Server-side reads of the pod's open records for pod pages: the same `@passport/appview` functions the
 * `/api/appview` mount calls, run inside the pod transaction (`withPod`), like the grants and events pages do.
 */
import 'server-only';
import type { PodContext } from '@passport/appview';
import { withPod } from '@passport/db';
import { db } from '@/lib/db';
import { platformDomain } from '@/lib/env';
import type { LoadedPod } from '@/lib/pod';

export function withAppview<T>(pod: LoadedPod, fn: (ctx: PodContext) => Promise<T>): Promise<T> {
  return withPod(db(), pod.slug, (tx) =>
    fn({ slug: pod.slug, podDid: pod.did, db: tx, manifest: pod.manifest, policy: pod.policy, now: () => new Date(), platformDomain: platformDomain() }),
  );
}
