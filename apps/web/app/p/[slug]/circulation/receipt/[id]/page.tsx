import type { Metadata } from 'next';
import { Notice, PageHeader } from '@passport/ui-kit';
import { ReceiptView } from '../../_components/ReceiptView';
import { circulationPage } from '../../_lib/pod';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Receipt' };

export default async function ReceiptPage({ params }: PageProps<'/p/[slug]/circulation/receipt/[id]'>) {
  const { slug, id } = await params;
  const { pod, base, session, unit, walletHref } = await circulationPage(slug);

  return (
    <div className="grid gap-8">
      <PageHeader title="Receipt" subtitle={`A payment in credits at ${pod.manifest.identity.name}, signed by the pod.`} />
      {session ? (
        <ReceiptView slug={slug} id={id} unit={unit} />
      ) : (
        <Notice kind="info">
          Present your passport to {pod.manifest.identity.name} to see this receipt. <a href={walletHref}>Open your passport</a>.
        </Notice>
      )}
      <p>
        <a href={`${base}/circulation`}>Back to my account</a>
      </p>
    </div>
  );
}
