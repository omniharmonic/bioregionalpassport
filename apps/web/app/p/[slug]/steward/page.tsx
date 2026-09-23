import type { Metadata } from 'next';
import { Notice, PageHeader } from '@passport/ui-kit';
import { loadPod } from '@/lib/pod';
import { getSession } from '@/lib/session';
import { StewardConsole } from './StewardConsole';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Steward' };

/**
 * Gated server-side by the `passport_session` cookie (Next's `cookies()`, read
 * inside `getSession()`) before anything steward-only renders — the same cookie
 * that `/api/vta/steward/*` and `/api/index/steward/*` check again on every
 * request, since this page's gate is UX only, not the real security boundary.
 */
export default async function StewardPage({ params }: PageProps<'/p/[slug]/steward'>) {
  const { slug } = await params;
  const [pod, session] = await Promise.all([loadPod(slug), getSession().catch(() => null)]);
  const isSteward = Boolean(session && session.pod === pod.did && session.authorities.includes('pep:review'));
  const canConvene = Boolean(session && session.authorities.includes('event:convene'));

  if (!isSteward) {
    return (
      <div className="grid gap-8">
        <PageHeader title="Steward console" subtitle={pod.manifest.identity.name} />
        <Notice kind="info">
          This console is for stewards. <a href={`/wallet?pod=${encodeURIComponent(slug)}`}>Open your passport</a> to check your standing in{' '}
          {pod.manifest.identity.name}.
        </Notice>
      </div>
    );
  }

  return (
    <div className="grid gap-8">
      <PageHeader title="Steward console" subtitle={`Review flags, members, events and disputes for ${pod.manifest.identity.name}.`} />
      <StewardConsole slug={slug} canConvene={canConvene} />
    </div>
  );
}
