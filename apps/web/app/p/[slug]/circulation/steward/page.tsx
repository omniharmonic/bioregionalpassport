import type { Metadata } from 'next';
import { Notice, PageHeader } from '@passport/ui-kit';
import { StewardConsole } from '../_components/StewardConsole';
import { circulationPage } from '../_lib/pod';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Circulation stewardship' };

export default async function CirculationStewardPage({ params }: PageProps<'/p/[slug]/circulation/steward'>) {
  const { slug } = await params;
  const { pod, base, session, unit, walletHref } = await circulationPage(slug);
  const name = pod.manifest.identity.name;
  const steward = session?.authorities.includes('pep:review') ?? false;

  return (
    <div className="grid gap-10">
      <PageHeader title="Circulation stewardship" subtitle={`How credits are moving in ${name}, and whether the pilot is healthy.`} />
      {steward ? (
        <StewardConsole slug={slug} unit={unit} />
      ) : (
        <Notice kind="info">
          {session
            ? `This console is for ${name}'s stewards; your passport does not carry the "pep:review" authority.`
            : `Present a steward's passport to ${name} to open this console.`}{' '}
          {session ? <a href={`${base}/circulation`}>Back to my account</a> : <a href={walletHref}>Open your passport</a>}
        </Notice>
      )}
    </div>
  );
}
