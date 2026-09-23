import 'server-only';
import { headers } from 'next/headers';
import { platformDomain } from './env';
import { podBase } from './podNav';
import { platformOriginFor } from './tenant';

/** True when the current request arrived on the pod's own host (proxy-rewritten). */
export async function onPodHost(slug: string): Promise<boolean> {
  const h = await headers();
  return h.get('x-pod-host') === '1' && h.get('x-pod') === slug;
}

/** Link base for pod pages in the current request. */
export async function currentPodBase(slug: string): Promise<string> {
  return podBase(slug, await onPodHost(slug));
}

/**
 * The platform origin as seen from the current request: `http(s)://localhost[:port]` when it arrived on
 * `<slug>.localhost`, else `https://<PLATFORM_DOMAIN>`. Used for absolute links from a pod host to the
 * wallet-dependent sections (ADR-032).
 */
export async function currentPlatformOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? '';
  const proto = h.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  let url: URL;
  try {
    url = new URL(`${proto}://${host || 'localhost'}`);
  } catch {
    url = new URL('https://invalid.invalid');
  }
  return platformOriginFor(url, platformDomain());
}
