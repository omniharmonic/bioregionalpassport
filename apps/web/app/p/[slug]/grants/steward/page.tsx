import type { Metadata } from 'next';
import { listAdjustments, listProposals, listRounds, type ProposalView, type RoundView, type TallyAdjustment } from '@passport/round';
import { Card, EmptyState, Explain, Notice, PageHeader, Pill } from '@passport/ui-kit';
import { loadPod } from '@/lib/pod';
import { currentPodBase } from '@/lib/podRequest';
import { STEWARD_SCOPE, can, podSession, withRound } from '../_lib/data';
import { PHASE_LABEL, money, phaseOf } from '../_lib/format';
import { abbreviate } from '../_lib/voting';
import { podDay, podTimeZone } from '../../events/_lib/podTime';
import { AdjustmentForm, CreateRoundForm, RoundActionButton } from './_components/StewardActions';
import { DONE, isDoneKey } from './_lib/done';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Round steward console' };

interface ConsoleRound extends RoundView {
  proposals: ProposalView[];
  adjustments: TallyAdjustment[];
}

const NEXT_ACTION = { draft: 'open', open: 'close', tallying: 'publish' } as const;

export default async function StewardConsolePage({ params, searchParams }: PageProps<'/p/[slug]/grants/steward'>) {
  const { slug } = await params;
  const doneRaw = (await searchParams)['done'];
  const doneKey = isDoneKey(doneRaw) ? doneRaw : null;
  const pod = await loadPod(slug);
  // Dates in the pod's own zone, not the server's UTC (issue 7 of the MVP e2e report).
  const tz = podTimeZone(pod.manifest);
  const day = (iso: string | null) => podDay(iso, tz);
  const [base, session] = await Promise.all([currentPodBase(slug), podSession(pod)]);

  if (!can(session, STEWARD_SCOPE)) {
    return (
      <div className="grid gap-8">
        <PageHeader title="Round steward console" />
        <Notice kind="info">
          This console is for {pod.manifest.identity.name}&rsquo;s stewards. It needs the &ldquo;pep:review&rdquo; permission, which{' '}
          {session ? 'your passport does not carry' : 'shows once you present your passport to this pod'}.{' '}
          {session ? null : <a href={`/wallet?pod=${encodeURIComponent(slug)}`}>Open your passport</a>}
        </Notice>
        <p>
          <a href={`${base}/grants`}>Back to grants</a>
        </p>
      </div>
    );
  }

  let rounds: ConsoleRound[] | null;
  try {
    rounds = await withRound(pod, async (ctx) => {
      const out: ConsoleRound[] = [];
      for (const r of await listRounds(ctx)) {
        const needsLog = r.status === 'tallying' || r.status === 'published';
        out.push({ ...r, proposals: await listProposals(ctx, r.id), adjustments: needsLog ? await listAdjustments(ctx, r.id) : [] });
      }
      return out;
    });
  } catch (err) {
    console.error('[grants/steward] could not list rounds', err);
    rounds = null;
  }

  return (
    <div className="grid gap-10">
      <PageHeader title="Round steward console" subtitle={`Grants rounds for ${pod.manifest.identity.name}.`} />
      <p>
        <a href={`${base}/grants`}>Back to grants</a>
      </p>

      <section aria-labelledby="create" className="grid gap-4">
        <h2 id="create" className="text-2xl font-medium">
          New round
        </h2>
        <Explain>A new round starts as a draft. Open it when the pool and dates are right; members can then propose and vote.</Explain>
        <Card>
          <CreateRoundForm slug={slug} unit={pod.manifest.currency.unit} />
        </Card>
      </section>

      <section aria-labelledby="rounds" className="grid gap-4">
        <h2 id="rounds" className="text-2xl font-medium">
          Rounds
        </h2>
        {doneKey ? (
          <div role="status">
            <Notice kind="success">{DONE[doneKey]}</Notice>
          </div>
        ) : null}
        {rounds === null ? (
          <p role="status">Rounds are not available right now. Please try again in a moment.</p>
        ) : rounds.length === 0 ? (
          <EmptyState title="No rounds yet" body="Create the first one above." />
        ) : (
          <ul className="grid gap-5">
            {rounds.map((r) => {
              const action = NEXT_ACTION[r.status as keyof typeof NEXT_ACTION];
              const titleOf = new Map(r.proposals.map((p) => [p.id, p.title]));
              return (
                <li key={r.id}>
                  <Card>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <h3 className="text-xl font-medium">
                        <a href={`${base}/grants/${encodeURIComponent(r.id)}`}>{r.title}</a>
                      </h3>
                      <Pill>{r.status === 'draft' ? 'Draft' : PHASE_LABEL[phaseOf(r)]}</Pill>
                    </div>
                    <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-[10rem_1fr]">
                      <dt className="muted">Pool</dt>
                      <dd>{money(r.pool, r.unit)}</dd>
                      <dt className="muted">Dates</dt>
                      <dd>
                        {day(r.opensAt)} to {day(r.closesAt)}
                      </dd>
                      <dt className="muted">Proposals</dt>
                      <dd>{r.proposals.length}</dd>
                      <dt className="muted">Eligibility</dt>
                      <dd>
                        Propose {r.eligibility.proposeTier}+, vote {r.eligibility.voteTier}+, {r.eligibility.voiceBudget} voice credits
                        {r.eligibility.matchingCap ? `, at most ${money(r.eligibility.matchingCap, r.unit)} per project` : ''}
                      </dd>
                    </dl>

                    <div className="mt-4 grid gap-4">
                      {action ? <RoundActionButton slug={slug} roundId={r.id} action={action} /> : null}

                      {r.status === 'tallying' ? (
                        <div className="grid gap-2">
                          <h4 className="font-medium">Adjust matching</h4>
                          <p className="text-sm muted">
                            Use this for review findings such as duplicate voters. Every adjustment is logged with your name and reason and published with the results.
                          </p>
                          <AdjustmentForm slug={slug} roundId={r.id} proposals={r.proposals.map((p) => ({ id: p.id, title: p.title }))} />
                        </div>
                      ) : null}

                      {r.status === 'tallying' || r.status === 'published' ? (
                        <div className="grid gap-2">
                          <h4 className="font-medium">Adjustment log</h4>
                          {r.adjustments.length === 0 ? (
                            <p className="text-sm muted">No adjustments.</p>
                          ) : (
                            <ul className="grid gap-1 text-sm">
                              {r.adjustments.map((a, i) => (
                                <li key={`${a.proposalId}-${i}`}>
                                  {titleOf.get(a.proposalId) ?? a.proposalId}: {a.delta > 0 ? '+' : ''}
                                  {money(a.delta, r.unit)} — {a.reason}{' '}
                                  <span className="muted">
                                    ({abbreviate(a.stewardDid)}, {day(a.createdAt)})
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : null}

                      <p className="text-sm">
                        <a href={`${base}/grants/${encodeURIComponent(r.id)}`}>Round page</a>
                        {r.status === 'open' ? (
                          <>
                            {' · '}
                            <a href={`${base}/grants/${encodeURIComponent(r.id)}/propose`}>Add a proposal</a>
                          </>
                        ) : null}
                        {r.status === 'draft' ? (
                          <>
                            {' · '}
                            <a href={`${base}/grants/${encodeURIComponent(r.id)}/propose`}>Add a proposal before opening</a>
                          </>
                        ) : null}
                      </p>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
