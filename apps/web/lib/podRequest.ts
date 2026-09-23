import 'server-only';
import { headers } from 'next/headers';
import { podBase } from './podNav';

/** True when the current request arrived on the pod's own host (proxy-rewritten). */
export async function onPodHost(slug: string): Promise<boolean> {
  const h = await headers();
  return h.get('x-pod-host') === '1' && h.get('x-pod') === slug;
}

/** Link base for pod pages in the current request. */
export async function currentPodBase(slug: string): Promise<string> {
  return podBase(slug, await onPodHost(slug));
}
