import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EmptyState, PageHeader } from '@passport/ui-kit';
import { loadPod } from '@/lib/pod';
import { podLinks } from '@/lib/podNav';
import { currentPodBase } from '@/lib/podRequest';

export const dynamic = 'force-dynamic';

/**
 * Placeholder for pod sections that have no page of their own yet. Map, directory, events and grants now
 * have static route folders (`app/p/[slug]/map` etc.), which take precedence over this dynamic segment; the
 * set is empty, so any other section is a 404. A future section can be listed here until its page lands.
 */
const SECTIONS = new Set<string>([]);

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
