import 'server-only';
import { notFound } from 'next/navigation';
import type { SessionClaims } from '@passport/service-kit';
import { copy } from '@passport/tenant-config';
import { loadPod, type LoadedPod } from '@/lib/pod';
import { currentPodBase } from '@/lib/podRequest';
import { getSession } from '@/lib/session';

export interface CirculationPage {
  pod: LoadedPod;
  base: string;
  /** The session when it was issued by this pod, else null. */
  session: SessionClaims | null;
  /** Page title for the module ("Credits" unless the pod renames it). */
  moduleLabel: string;
  unit: string;
  walletHref: string;
}

/** Loads what every circulation page needs; 404s when the pod has not turned local credits on. */
export async function circulationPage(slug: string): Promise<CirculationPage> {
  const [pod, base, raw] = await Promise.all([loadPod(slug), currentPodBase(slug), getSession().catch(() => null)]);
  if (!pod.manifest.modules.circulation) notFound();
  const label = copy(pod.manifest, 'module.circulation');
  return {
    pod,
    base,
    session: raw && raw.pod === pod.did ? raw : null,
    moduleLabel: label === 'module.circulation' ? 'Credits' : label,
    unit: pod.manifest.currency.unit,
    walletHref: `/wallet?pod=${encodeURIComponent(slug)}`,
  };
}
