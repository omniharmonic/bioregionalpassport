'use client';

import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@passport/ui-kit';
import { JoinPod } from './_components/JoinPod';
import { Onboarding } from './_components/Onboarding';
import { PodHome } from './_components/PodHome';
import { useWalletState } from './_lib/WalletContext';

/** `/wallet`: onboarding (F1) until the passport has joined a pod, then the pod home. */
export default function WalletHome() {
  const w = useWalletState();
  const params = useSearchParams();
  if (!w.ready) return null;
  // `?pod=<slug>` for a pod this passport has not joined behaves like `?join=<slug>` (e.g. the redirect from a pod
  // host): straight to its join screen (with the persona choice), or onboarding with that pod preselected.
  const requested = (params?.get('join') ?? params?.get('pod') ?? '').trim().toLowerCase();
  const wantsJoin = /^[a-z0-9-]{2,40}$/.test(requested) && !w.pods.some((p) => p.slug === requested);
  if (!w.exists || w.pods.length === 0) return <Onboarding initialPod={wantsJoin ? requested : undefined} />;
  if (wantsJoin) {
    return (
      <div className="grid gap-6">
        <PageHeader title="Join a pod" />
        <JoinPod slug={requested} />
      </div>
    );
  }
  if (!w.pod) return <Onboarding />;
  return <PodHome />;
}
