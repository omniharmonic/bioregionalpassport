import type { Metadata } from 'next';
import { getRound, getTally, publicTally, type PublishedBallot, type Tally, type TallyAdjustment } from '@passport/round';
import { Button, Card, EmptyState, Explain, Notice, PageHeader, Pill, Stat } from '@passport/ui-kit';
import { loadPod } from '@/lib/pod';
import { currentPodBase } from '@/lib/podRequest';
import { STEWARD_SCOPE, can, notFoundOn404, podDomain, podSession, trustedName, withRound } from '../_lib/data';
import { PHASE_LABEL, money, phaseOf } from '../_lib/format';
import { podDay, podTimeZone } from '../../events/_lib/podTime';
import { abbreviate } from '../_lib/voting';
import { VerifyTally } from '../_components/VerifyTally';
import { VotingIsland } from '../_components/VotingIsland';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Grants round' };

type ShownTally = Tally | Omit<Tally, 'adjustments'>;

export default async function RoundPage({ params }: PageProps<'/p/[slug]/grants/[id]'>) {
  const { slug, id } = await params;
  const pod = await loadPod(slug);
  const timeZone = podTimeZone(pod.manifest);
  const day = (iso: string | null) => podDay(iso, timeZone);
  const [base, session] = await Promise.all([currentPodBase(slug), podSession(pod)]);
  const steward = can(session, STEWARD_SCOPE);

  const data = await withRound(pod, async (ctx) => {
    const { tally: rawTally, ...round } = await getRound(ctx, id);
    let tally: ShownTally | null = null;
    let ballots: PublishedBallot[] = [];
    if (rawTally && (round.status === 'tallying' || round.status === 'published')) {
      const t = await getTally(ctx, id);
      tally = publicTally(t.tally, round.status, steward);
      ballots = t.ballots;
    }
    return { round, tally, ballots };
  }).catch(notFoundOn404);

  const { round, tally, ballots } = data;
  const phase = phaseOf(round);
  const now = Date.now();
  const votingWindow = round.status === 'open' && !(round.opensAt && Date.parse(round.opensAt) > now) && !(round.closesAt && Date.parse(round.closesAt) < now);
  const walletHref = `/wallet?pod=${encodeURIComponent(slug)}`;
  const titleOf = new Map(round.proposals.map((p) => [p.id, p.title]));
  const canPropose = can(session, 'round:propose') && (round.status === 'open' || (round.status === 'draft' && steward));
  const adjustments: TallyAdjustment[] = tally && 'adjustments' in tally ? tally.adjustments : [];

  return (
    <div className="grid gap-10">
      <PageHeader
        title={round.title}
        subtitle={`${PHASE_LABEL[phase]} · ${day(round.opensAt)} to ${day(round.closesAt)}`}
        actions={
          canPropose ? (
            <Button href={`${base}/grants/${encodeURIComponent(round.id)}/propose`}>Propose a project</Button>
          ) : undefined
        }
      />
      <p>
        <a href={`${base}/grants`}>All grants rounds</a>
      </p>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Pool" value={money(round.pool, round.unit)} />
        <Stat label="Proposals" value={round.proposals.length} />
        <Stat label="Voice credits per voter" value={round.eligibility.voiceBudget} />
      </div>

      {round.status === 'open' && !canPropose ? (
        <Explain>
          Proposing needs {trustedName(pod.manifest)} standing or above and a passport presented to this pod.
        </Explain>
      ) : null}

      <section aria-labelledby="proposals" className="grid gap-4">
        <h2 id="proposals" className="text-2xl font-medium">
          Proposals
        </h2>
        {round.proposals.length === 0 ? (
          <EmptyState title="No proposals yet" body="Members propose projects while the round is open." />
        ) : (
          <ul className="grid gap-4">
            {round.proposals.map((p) => (
              <li key={p.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <h3 className="text-lg font-medium">{p.title}</h3>
                    <Pill>{money(p.budget, round.unit)}</Pill>
                  </div>
                  {p.summary ? <p className="mt-2">{p.summary}</p> : null}
                  <p className="mt-2 text-sm muted">
                    Lead <code>{abbreviate(p.leadDid)}</code>
                    {p.placeId ? <> · Place {p.placeId}</> : null}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {round.status === 'open' ? (
        <section aria-labelledby="vote" className="grid gap-4">
          <h2 id="vote" className="text-2xl font-medium">
            Vote
          </h2>
          <Explain>
            Spread your voice credits across the projects you support. Your ballot is signed with a key made for this round only, so it is published without your name.
          </Explain>
          {!votingWindow ? (
            <Notice kind="info">
              {round.opensAt && Date.parse(round.opensAt) > now
                ? `Voting opens on ${day(round.opensAt)}.`
                : `Voting closed on ${day(round.closesAt)}; the stewards are about to count the ballots.`}
            </Notice>
          ) : round.proposals.length === 0 ? (
            <Notice kind="info">There is nothing to vote on yet.</Notice>
          ) : (
            <VotingIsland
              slug={slug}
              roundId={round.id}
              proposals={round.proposals.map((p) => ({ id: p.id, title: p.title }))}
              voiceBudget={round.eligibility.voiceBudget}
              domain={podDomain(slug)}
              walletHref={walletHref}
              signedIn={session !== null}
            />
          )}
        </section>
      ) : null}

      {tally ? (
        <section aria-labelledby="results" className="grid gap-4">
          <h2 id="results" className="text-2xl font-medium">
            {round.status === 'published' ? 'Results' : 'Provisional results'}
          </h2>
          {round.status === 'tallying' ? (
            <Notice kind="info">Voting has closed. Stewards are reviewing the count before publishing it.</Notice>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b rule">
                  <th className="py-2 pr-4 font-medium">Proposal</th>
                  <th className="py-2 pr-4 font-medium">Votes</th>
                  <th className="py-2 pr-4 font-medium">Voters</th>
                  <th className="py-2 pr-4 font-medium">Matching</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {tally.proposals.map((e) => (
                  <tr key={e.id} className="border-b rule">
                    <td className="py-2 pr-4">{titleOf.get(e.id) ?? e.id}</td>
                    <td className="py-2 pr-4 tabular-nums">{e.votes ?? e.rawVotes}</td>
                    <td className="py-2 pr-4 tabular-nums">{e.voters}</td>
                    <td className="py-2 pr-4 tabular-nums">
                      {money(e.matching, round.unit)}
                      {e.adjustment ? <span className="muted"> (adjusted {e.adjustment > 0 ? '+' : ''}{e.adjustment})</span> : null}
                    </td>
                    <td className="py-2">{e.matching > 0 ? <Pill tone="accent">Funded</Pill> : <Pill>Not funded</Pill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="grid gap-1 text-sm sm:grid-cols-[12rem_1fr]">
            <dt className="muted">Ballots counted</dt>
            <dd>{tally.ballotCount}</dd>
            {tally.unallocated > 0 ? (
              <>
                <dt className="muted">Left in the pool</dt>
                <dd>{money(tally.unallocated, round.unit)}</dd>
              </>
            ) : null}
            <dt className="muted">Fingerprint of all ballots</dt>
            <dd>
              <code className="break-all">{tally.verifiable?.ballotsHash ?? tally.ballotsHash}</code>
            </dd>
          </dl>
          <Explain>
            Anyone can recompute this result from the published ballots below. The fingerprint changes if any ballot is altered.
          </Explain>
          <VerifyTally slug={slug} roundId={round.id} />

          {adjustments.length > 0 ? (
            <div className="grid gap-2">
              <h3 className="text-lg font-medium">Steward adjustments</h3>
              <ul className="grid gap-2 text-sm">
                {adjustments.map((a, i) => (
                  <li key={`${a.proposalId}-${i}`}>
                    {titleOf.get(a.proposalId) ?? a.proposalId}: {a.delta > 0 ? '+' : ''}
                    {money(a.delta, round.unit)} — {a.reason} <span className="muted">({abbreviate(a.stewardDid)}, {day(a.createdAt)})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-2">
            <h3 className="text-lg font-medium">Published ballots</h3>
            {ballots.length === 0 ? (
              <p className="muted">No ballots were cast.</p>
            ) : (
              <ul className="grid gap-2 text-sm">
                {ballots.map((b) => (
                  <li key={b.voterKey} className="grid gap-1">
                    <span>
                      <code>{abbreviate(b.voterKey)}</code>
                      {b.onBehalfOf ? <span className="muted"> · for a group</span> : null}
                      <span className="muted"> · {b.tier}</span>
                    </span>
                    <span className="muted">
                      {Object.entries(b.allocations)
                        .filter(([, v]) => v > 0)
                        .map(([pid, v]) => `${titleOf.get(pid) ?? pid}: ${v}`)
                        .join(' · ') || 'No votes'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
