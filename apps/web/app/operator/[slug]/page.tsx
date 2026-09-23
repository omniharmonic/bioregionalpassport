import type { Metadata } from 'next';
import { PageHeader } from '@passport/ui-kit';
import { isSlug } from '@/lib/tenant';
import { notFound } from 'next/navigation';
import { OperatorPodConsole } from './OperatorPodConsole';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Operator', robots: { index: false } };

/**
 * Server shell only — see `apps/web/app/operator/page.tsx`. This pod's manifest,
 * policy and counts are only ever fetched client-side, with the operator's Bearer
 * token, through `/api/control/health?slug=<slug>`.
 */
export default async function OperatorPodPage({ params }: PageProps<'/operator/[slug]'>) {
  const { slug } = await params;
  if (!isSlug(slug)) notFound();

  return (
    <div className="min-h-screen">
      <header className="mx-auto max-w-5xl px-6 pt-8 sm:px-10">
        <a href="/operator" className="font-display text-lg font-semibold no-underline" style={{ color: 'var(--bp-fg)' }}>
          ← Operator
        </a>
      </header>
      <main id="main" className="mx-auto grid max-w-5xl gap-10 px-6 py-12 sm:px-10">
        <PageHeader title={slug} subtitle="Manifest, governance, trust policy, modules, health and export." />
        <OperatorPodConsole slug={slug} />
      </main>
    </div>
  );
}
