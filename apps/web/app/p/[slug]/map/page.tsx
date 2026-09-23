import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Explain, PageHeader } from '@passport/ui-kit';
import { copy } from '@passport/tenant-config';
import { loadPod } from '@/lib/pod';
import { currentPodBase } from '@/lib/podRequest';
import { podTimeZone } from '../events/_lib/podTime';
import { PodMap } from './_components/PodMap';
import { boundsOf } from './_lib/features';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Map' };

/** The pod map: open records with coordinates (`GET /api/appview/map`), drawn by a MapLibre island. */
export default async function MapPage({ params, searchParams }: PageProps<'/p/[slug]/map'>) {
  const { slug } = await params;
  const sp = await searchParams;
  const pod = await loadPod(slug);
  if (!pod.manifest.modules.map) notFound();
  const base = await currentPodBase(slug);
  const focusRaw = Array.isArray(sp['focus']) ? sp['focus'][0] : sp['focus'];
  const focus = typeof focusRaw === 'string' && focusRaw.length <= 500 ? focusRaw : null;

  return (
    <div className="grid gap-8">
      <PageHeader title={copy(pod.manifest, 'module.map')} subtitle={`${pod.manifest.identity.name} on the land.`} />
      <Explain>Places, gatherings and enterprises in this bioregion, as open records.</Explain>
      <PodMap slug={slug} base={base} bounds={boundsOf(pod.manifest.place.bounds)} timeZone={podTimeZone(pod.manifest)} focus={focus} />
    </div>
  );
}
