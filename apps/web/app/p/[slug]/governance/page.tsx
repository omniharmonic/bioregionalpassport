import type { Metadata } from 'next';
import { Card, PageHeader, TierBadge, type Tier } from '@passport/ui-kit';
import { loadPod } from '@/lib/pod';
import { describeRule, tierName } from '@/lib/podCopy';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Governance' };

const TIERS: Tier[] = ['T1', 'T2', 'T3', 'T4'];

const contactHref = (c: string): string => (/^[^@\s]+@[^@\s]+$/.test(c) ? `mailto:${c}` : c);

export default async function GovernancePage({ params }: PageProps<'/p/[slug]/governance'>) {
  const { slug } = await params;
  const { manifest, policy } = await loadPod(slug);
  const gov = manifest.governance;

  return (
    <div className="grid gap-12">
      <PageHeader
        title="Governance"
        subtitle={`Who stewards ${manifest.identity.name}, and the rules by which neighbors come to trust one another.`}
      />

      <section aria-labelledby="charter" className="grid gap-4">
        <h2 id="charter" className="text-2xl font-medium">
          Charter and stewards
        </h2>
        <dl className="grid gap-4 sm:grid-cols-[12rem_1fr]">
          <dt className="muted">Governance document</dt>
          <dd>
            <a href={gov.url}>{gov.url}</a>
          </dd>
          <dt className="muted">What we disclose</dt>
          <dd>{gov.disclosure}</dd>
          <dt className="muted">Anchors</dt>
          <dd>
            {gov.anchors.length === 0 ? (
              'No anchors have been named yet.'
            ) : (
              <ul className="grid gap-1">
                {gov.anchors.map((a) => (
                  <li key={a}>
                    <code className="break-all text-sm">{a}</code>
                  </li>
                ))}
              </ul>
            )}
          </dd>
          <dt className="muted">Disputes</dt>
          <dd>
            <a href={contactHref(gov.disputes)}>{gov.disputes}</a>
          </dd>
        </dl>
      </section>

      <section aria-labelledby="trust" className="grid gap-6">
        <div>
          <h2 id="trust" className="text-2xl font-medium">
            How standing is earned
          </h2>
          <p className="mt-2 max-w-2xl muted">
            Trust policy version {policy.version}. Each level includes everything below it.
          </p>
        </div>
        <ol className="grid gap-5">
          {TIERS.map((t) => (
            <li key={t}>
              <Card>
                <h3 className="flex items-center gap-3 text-xl font-medium">
                  <TierBadge tier={t} name={tierName(manifest, t)} />
                </h3>
                <ul className="mt-4 grid list-disc gap-2 pl-5">
                  {policy.tiers[t as 'T1' | 'T2' | 'T3' | 'T4'].requires.map((r) => (
                    <li key={r}>{describeRule(manifest, r)}</li>
                  ))}
                </ul>
              </Card>
            </li>
          ))}
        </ol>
        <ul className="grid max-w-2xl list-disc gap-2 pl-5 muted">
          <li>
            Permissions last {policy.vacValidityDays} days and renew for as long as your standing holds.
          </li>
          {policy.downgradeAtExpiryOnly ? <li>Your standing is never lowered before your current permissions expire.</li> : null}
          {policy.idvcRequired ? null : <li>No government ID is ever required.</li>}
        </ul>
      </section>
    </div>
  );
}
