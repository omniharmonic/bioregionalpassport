import 'server-only';
import { notFound } from 'next/navigation';
import { getPod, loadPodSigner as loadSigner, type PodSigner } from '@passport/control-plane';
import { defaultTrustPolicy, type BioregionManifest, type TrustPolicy } from '@passport/tenant-config';
import { db, jsonValue } from './db';
import { env } from './env';
import { isSlug } from './tenant';

export interface LoadedPod {
  slug: string;
  did: string;
  manifest: BioregionManifest;
  /** Latest signed policy, or the B3 §4 defaults when none is written yet. */
  policy: TrustPolicy;
  status: string;
}

const TTL_MS = 60_000;

interface Entry<T> {
  at: number;
  value: Promise<T>;
}

const podCache = new Map<string, Entry<LoadedPod>>();

class PodMissing extends Error {}
const signerCache = new Map<string, Entry<PodSigner>>();

function cached<T>(cache: Map<string, Entry<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  // Never cache a failure.
  value.catch(() => cache.delete(key));
  return value;
}

/** The pod (manifest, policy, DID, status) or `null`, cached for 60 s per server instance. */
export function findPod(slug: string): Promise<LoadedPod | null> {
  if (!isSlug(slug)) return Promise.resolve(null);
  return cached(podCache, slug, async () => {
    const view = await getPod(db(), slug);
    // Throwing (not returning null) keeps a missing pod out of the cache, so a pod
    // provisioned moments later is found immediately.
    if (!view) throw new PodMissing();
    const policy = view.policy === null ? null : jsonValue<TrustPolicy>(view.policy);
    return {
      slug: view.slug,
      did: view.did,
      manifest: jsonValue<BioregionManifest>(view.manifest),
      policy: policy ?? defaultTrustPolicy(view.did),
      status: view.status,
    };
  }).catch((err: unknown) => {
    if (err instanceof PodMissing) return null;
    throw err;
  });
}

/** Loads an active pod for a page, or renders the 404 page. */
export async function loadPod(slug: string): Promise<LoadedPod> {
  const pod = await findPod(slug);
  if (!pod || pod.status !== 'active') notFound();
  return pod;
}

/** The pod's decrypted signer (ADR-27), cached for 60 s per server instance. */
export function loadPodSigner(slug: string): Promise<PodSigner> {
  return cached(signerCache, slug, () => loadSigner(db(), slug, env().POD_KEY_ENCRYPTION_KEY));
}

/** Drops cached pod data (e.g. after a manifest update through the control plane). */
export function invalidatePod(slug?: string): void {
  if (slug) {
    podCache.delete(slug);
    signerCache.delete(slug);
  } else {
    podCache.clear();
    signerCache.clear();
  }
}
