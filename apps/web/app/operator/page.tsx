import type { Metadata } from 'next';
import { boulderManifest, tenantZeroManifest } from '@passport/tenant-config';
import { PageHeader } from '@passport/ui-kit';
import { platformDomain } from '@/lib/env';
import { OperatorConsole } from './OperatorConsole';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Operator', robots: { index: false } };

/**
 * Server shell only: no pod data is read or rendered here. The operator token
 * gates every pod-carrying request, and every pod-carrying request happens
 * client-side (`OperatorConsole`) once the operator has supplied it — the
 * platform database is never queried for an anonymous request to this page.
 */
export default function OperatorPage() {
  const domain = platformDomain();
  const templates = {
    boulder: JSON.stringify(boulderManifest, null, 2),
    'tenant-zero': JSON.stringify(tenantZeroManifest, null, 2),
  };

  return (
    <div className="min-h-screen">
      <header className="mx-auto max-w-5xl px-6 pt-8 sm:px-10">
        <a href="/" className="font-display text-lg font-semibold no-underline" style={{ color: 'var(--bp-fg)' }}>
          Bioregional Passport
        </a>
      </header>
      <main id="main" className="mx-auto grid max-w-5xl gap-10 px-6 py-12 sm:px-10">
        <PageHeader title="Operator" subtitle={`Pods hosted on ${domain}.`} />
        <OperatorConsole templates={templates} />
      </main>
    </div>
  );
}
