import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Explain, Notice, PageHeader } from '@passport/ui-kit';
import { circulationPage } from '../circulation/_lib/pod';
import { MerchantMode } from './_components/MerchantMode';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Merchant Mode' };

export default async function MerchantPage({ params }: PageProps<'/p/[slug]/merchant'>) {
  const { slug } = await params;
  const { pod, base, session, unit, walletHref } = await circulationPage(slug);
  if (!pod.manifest.modules.merchant) notFound();
  const name = pod.manifest.identity.name;
  // Enterprises this session may ring up for: `pay:receive@<enterpriseDid>` (owner's root authority or staff's).
  const receiveScopes = (session?.authorities ?? []).filter((a) => a.startsWith('pay:receive@')).map((a) => a.slice('pay:receive@'.length));

  return (
    <div className="grid gap-10">
      <PageHeader title="Merchant Mode" subtitle={`Accept credits at your enterprise in ${name}, alongside your usual till.`} />
      <Explain>
        A customer pays part of a sale in credits and the rest in dollars on your usual rails. Credits you take in are yours to
        spend with other local enterprises and neighbors; your ceiling keeps you from holding more than you can use. Credits are
        never bought or sold.
      </Explain>
      {session ? (
        <MerchantMode
          slug={slug}
          podDid={pod.did}
          walletHref={walletHref}
          base={base}
          unit={unit}
          subject={session.subject}
          receiveScopes={receiveScopes}
          defaultAcceptance={pod.manifest.currency.defaultAcceptance}
        />
      ) : (
        <Notice kind="info">
          Present your passport to {name} to open Merchant Mode. <a href={walletHref}>Open your passport</a>.
        </Notice>
      )}
    </div>
  );
}
