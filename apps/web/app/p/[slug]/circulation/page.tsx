import type { Metadata } from 'next';
import { Button, Explain, Notice, PageHeader } from '@passport/ui-kit';
import { MemberAccount } from './_components/MemberAccount';
import { unitLabel } from './_lib/format';
import { circulationPage } from './_lib/pod';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Credits' };

export default async function CirculationPage({ params }: PageProps<'/p/[slug]/circulation'>) {
  const { slug } = await params;
  const { pod, base, session, moduleLabel, unit, walletHref } = await circulationPage(slug);
  const name = pod.manifest.identity.name;
  const isSteward = session?.authorities.includes('pep:review') ?? false;
  const isMerchant = session?.authorities.some((a) => a.startsWith('pay:receive@')) ?? false;

  return (
    <div className="grid gap-10">
      <PageHeader
        title={moduleLabel}
        subtitle={`Local credit in ${name}: what neighbors owe one another, kept in one shared ledger.`}
        actions={
          <div className="flex flex-wrap gap-3">
            <Button href={`${base}/merchant`} variant="secondary" size="sm">
              {isMerchant ? 'Merchant Mode' : 'Accept credits at your enterprise'}
            </Button>
            {isSteward ? (
              <Button href={`${base}/circulation/steward`} variant="secondary" size="sm">
                Steward console
              </Button>
            ) : null}
          </div>
        }
      />

      <Explain>
        <strong>How credits work.</strong> You earn {unitLabel(unit, 2)} by offering something to a neighbor or a local enterprise, and
        spend them with neighbors who accept them. Every credit someone holds is matched by a credit someone else owes, so the
        ledger always sums to zero. Your limit is how far below zero you may go while you are earning your way back. Credits are
        never bought or sold, and they are not money: the rest of a sale is paid in dollars on the usual till.
      </Explain>

      {session ? (
        <MemberAccount slug={slug} unit={unit} base={base} />
      ) : (
        <Notice kind="info">
          Present your passport to {name} to see your account. <a href={walletHref}>Open your passport</a>.
        </Notice>
      )}
    </div>
  );
}
