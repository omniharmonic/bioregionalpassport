'use client';

import { useParams } from 'next/navigation';
import { PageHeader } from '@passport/ui-kit';
import { JoinPod } from '../../_components/JoinPod';
import { Onboarding } from '../../_components/Onboarding';
import { useWalletState } from '../../_lib/WalletContext';

/**
 * Deep-link target for joining a pod: `/wallet/join/<slug>`. The native scheme `passport://join/<slug>` (and the
 * PWA's registered `web+passport://join/<slug>`) map here through `/wallet/join?to=…`.
 */
export default function JoinPage() {
  const params = useParams<{ slug: string }>();
  const slug = decodeURIComponent(params?.slug ?? '').toLowerCase();
  const w = useWalletState();
  if (!w.exists) return <Onboarding initialPod={slug} />;
  return (
    <div className="grid gap-6">
      <PageHeader title="Join a pod" />
      <JoinPod slug={slug} />
    </div>
  );
}
