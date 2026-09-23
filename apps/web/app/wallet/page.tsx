'use client';

import { useSearchParams } from 'next/navigation';
import { Onboarding } from './_components/Onboarding';
import { PodHome } from './_components/PodHome';
import { useWalletState } from './_lib/WalletContext';

/** `/wallet`: onboarding (F1) until the passport has joined a pod, then the pod home. */
export default function WalletHome() {
  const w = useWalletState();
  const params = useSearchParams();
  if (!w.ready) return null;
  if (!w.exists || w.pods.length === 0 || !w.pod) return <Onboarding initialPod={params?.get('join') ?? undefined} />;
  return <PodHome />;
}
