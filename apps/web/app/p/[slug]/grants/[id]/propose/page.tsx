import type { Metadata } from 'next';
import { getRound } from '@passport/round';
import { Explain, Notice, PageHeader } from '@passport/ui-kit';
import { loadPod } from '@/lib/pod';
import { currentPodBase } from '@/lib/podRequest';
import { STEWARD_SCOPE, can, notFoundOn404, podSession, trustedName, withRound } from '../../_lib/data';
import { ProposeForm } from '../../_components/ProposeForm';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Propose a project' };

export default async function ProposePage({ params }: PageProps<'/p/[slug]/grants/[id]/propose'>) {
  const { slug, id } = await params;
  const pod = await loadPod(slug);
  const [base, session] = await Promise.all([currentPodBase(slug), podSession(pod)]);
  const round = await withRound(pod, (ctx) => getRound(ctx, id)).catch(notFoundOn404);
  const roundHref = `${base}/grants/${encodeURIComponent(round.id)}`;
  const open = round.status === 'open' || (round.status === 'draft' && can(session, STEWARD_SCOPE));

  return (
    <div className="grid gap-8">
      <PageHeader title="Propose a project" subtitle={`For ${round.title}.`} />
      <p>
        <a href={roundHref}>Back to the round</a>
      </p>
      {!open ? (
        <Notice kind="info">This round is not taking proposals right now.</Notice>
      ) : !session ? (
        <Notice kind="info">
          Present your passport to {pod.manifest.identity.name} first. <a href={`/wallet?pod=${encodeURIComponent(slug)}`}>Open your passport</a>.
        </Notice>
      ) : !can(session, 'round:propose') ? (
        <Notice kind="info">
          Proposing needs {trustedName(pod.manifest)} standing or above, which your passport does not show yet.
        </Notice>
      ) : (
        <>
          <Explain>Your proposal is published as an open record with you as its lead. Members then vote on it.</Explain>
          <ProposeForm slug={slug} roundId={round.id} unit={round.unit} roundHref={roundHref} />
        </>
      )}
    </div>
  );
}
