import type { Metadata } from 'next';
import { listRounds, type RoundView } from '@passport/round';
import { Card, EmptyState, Explain, PageHeader, Pill } from '@passport/ui-kit';
import { loadPod } from '@/lib/pod';
import { currentPodBase } from '@/lib/podRequest';
import { STEWARD_SCOPE, can, podSession, trustedName, withRound } from './_lib/data';
import { PHASE_LABEL, day, money, phaseOf, type RoundPhase } from './_lib/format';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Grants' };

interface Listed extends RoundView {
  proposalCount: number;
}

async function loadRounds(pod: Awaited<ReturnType<typeof loadPod>>): Promise<Listed[] | null> {
  try {
    return await withRound(pod, async (ctx) => {
      const rounds = await listRounds(ctx);
      const counts = await ctx.db.query<{ round_id: string; n: number | string }>(
        'SELECT round_id, count(*) AS n FROM proposals GROUP BY round_id',
      );
      const byRound = new Map(counts.map((c) => [c.round_id, Number(c.n)]));
      return rounds.map((r) => ({ ...r, proposalCount: byRound.get(r.id) ?? 0 }));
    });
  } catch (err) {
    console.error('[grants] could not list rounds', err);
    return null;
  }
}

const ORDER: RoundPhase[] = ['open', 'upcoming', 'counting', 'published'];

export default async function GrantsPage({ params }: PageProps<'/p/[slug]/grants'>) {
  const { slug } = await params;
  const pod = await loadPod(slug);
  const [rounds, base, session] = await Promise.all([loadRounds(pod), currentPodBase(slug), podSession(pod)]);
  const grouped = new Map<RoundPhase, Listed[]>(ORDER.map((p) => [p, []]));
  for (const r of rounds ?? []) grouped.get(phaseOf(r))!.push(r);

  return (
    <div className="grid gap-8">
      <PageHeader
        title="Grants"
        subtitle={`Shared funds for projects in ${pod.manifest.identity.name}, decided by members.`}
        actions={can(session, STEWARD_SCOPE) ? <a href={`${base}/grants/steward`}>Round steward console</a> : undefined}
      />
      <Explain>
        Members at {trustedName(pod.manifest)} level propose and vote; votes are quadratic so many small voices outweigh one loud one.
      </Explain>

      {rounds === null ? (
        <p role="status">Grants rounds are not available right now. Please try again in a moment.</p>
      ) : rounds.length === 0 ? (
        <EmptyState title="No grants rounds yet" body="Stewards open a round with a pool and dates. Check back soon." />
      ) : (
        ORDER.filter((p) => grouped.get(p)!.length > 0).map((phase) => (
          <section key={phase} aria-labelledby={`phase-${phase}`} className="grid gap-4">
            <h2 id={`phase-${phase}`} className="text-2xl font-medium">
              {PHASE_LABEL[phase]}
            </h2>
            <ul className="grid gap-5">
              {grouped.get(phase)!.map((r) => (
                <li key={r.id}>
                  <Card>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <h3 className="text-xl font-medium">
                        <a href={`${base}/grants/${encodeURIComponent(r.id)}`}>{r.title}</a>
                      </h3>
                      <Pill tone={phase === 'open' ? 'accent' : 'neutral'}>{r.status === 'draft' ? 'Not yet open' : PHASE_LABEL[phase]}</Pill>
                    </div>
                    <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
                      <dt className="muted">Pool</dt>
                      <dd>{money(r.pool, r.unit)}</dd>
                      <dt className="muted">Dates</dt>
                      <dd>
                        {day(r.opensAt)} to {day(r.closesAt)}
                      </dd>
                      <dt className="muted">Proposals</dt>
                      <dd>{r.proposalCount === 1 ? '1 proposal' : `${r.proposalCount} proposals`}</dd>
                    </dl>
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
