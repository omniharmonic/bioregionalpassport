import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EmptyState, PageHeader } from '@passport/ui-kit';
import { loadPod } from '@/lib/pod';
import { podLinks } from '@/lib/podNav';
import { currentPodBase } from '@/lib/podRequest';

export const dynamic = 'force-dynamic';

/**
 * Placeholder for pod sections whose pages land in later tasks (map, directory,
 * grants). A static route folder such as `app/p/[slug]/grants`
 * takes precedence over this dynamic segment, so later tasks need no change here.
 */
const SECTIONS = new Set(['map', 'directory', 'grants']);

export async function generateMetadata({ params }: PageProps<'/p/[slug]/[section]'>): Promise<Metadata> {
  const { section } = await params;
  return { title: section.charAt(0).toUpperCase() + section.slice(1) };
}

export default async function SectionPlaceholder({ params }: PageProps<'/p/[slug]/[section]'>) {
  const { slug, section } = await params;
  if (!SECTIONS.has(section)) notFound();
  const [pod, base] = await Promise.all([loadPod(slug), currentPodBase(slug)]);
  const link = podLinks(pod.manifest, base).find((l) => l.key === section);
  if (!link) notFound();

  return (
    <div className="grid gap-8">
      <PageHeader title={link.label} subtitle={link.blurb} />
      <EmptyState
        title="Opening soon"
        body={`${pod.manifest.identity.name} is setting this up. In the meantime, the best way in is an in-person gathering.`}
        action={<a href={`${base}/events`}>See upcoming events</a>}
      />
    </div>
  );
}
