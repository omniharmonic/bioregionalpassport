import type { Metadata } from 'next';
import { listPods, withPod, type PodListing } from '@passport/db';
import { boulderManifest, tenantZeroManifest } from '@passport/tenant-config';
import { Card, PageHeader, Stat } from '@passport/ui-kit';
import { ProvisionForm } from '@/components/ProvisionForm';
import { db } from '@/lib/db';
import { platformDomain } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Operator', robots: { index: false } };

interface PodHealth {
  pod: PodListing;
  members: Record<string, number>;
  events: number;
  error?: boolean;
}

async function podHealth(pod: PodListing): Promise<PodHealth> {
  try {
    return await withPod(db(), pod.slug, async (tx) => {
      const tiers = await tx.query<{ tier: string; n: number }>('select tier, count(*)::int as n from members group by tier order by tier');
      const events = await tx.query<{ n: number }>('select count(*)::int as n from events');
      return { pod, members: Object.fromEntries(tiers.map((r) => [r.tier, Number(r.n)])), events: Number(events[0]?.n ?? 0) };
    });
  } catch (err) {
    console.error(`[operator] health for ${pod.slug}`, err);
    return { pod, members: {}, events: 0, error: true };
  }
}

async function load(): Promise<PodHealth[] | null> {
  try {
    const pods = await listPods(db());
    return await Promise.all(pods.map(podHealth));
  } catch (err) {
    console.error('[operator] could not list pods', err);
    return null;
  }
}

const TIER_ORDER = ['T0', 'T1', 'T2', 'T3', 'T4'];

export default async function OperatorPage() {
  const health = await load();
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
      <main id="main" className="mx-auto grid max-w-5xl gap-14 px-6 py-12 sm:px-10">
        <PageHeader title="Operator" subtitle={`Pods hosted on ${domain}. The full console arrives in a later release.`} />

        <section aria-labelledby="pods" className="grid gap-5">
          <h2 id="pods" className="text-2xl font-medium">
            Pods
          </h2>
          {health === null ? (
            <p role="status">The platform database is not reachable right now.</p>
          ) : health.length === 0 ? (
            <p>No pods are provisioned yet.</p>
          ) : (
            <ul className="grid gap-5">
              {health.map(({ pod, members, events, error }) => {
                const total = Object.values(members).reduce((a, b) => a + b, 0);
                return (
                  <li key={pod.slug}>
                    <Card>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="text-xl font-medium">
                          <a href={`/p/${pod.slug}`}>{pod.slug}</a>
                        </h3>
                        <span className="text-sm">Status: {pod.status}</span>
                      </div>
                      <p className="mt-1 break-all text-xs muted">{pod.did}</p>
                      {error ? (
                        <p className="mt-4 text-sm">Health numbers are not available for this pod.</p>
                      ) : (
                        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
                          <Stat label="Members" value={total} />
                          <Stat label="Events" value={events} />
                          {TIER_ORDER.filter((t) => members[t]).map((t) => (
                            <Stat key={t} label={`At ${t}`} value={members[t] ?? 0} />
                          ))}
                        </div>
                      )}
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="provision" className="grid gap-5">
          <h2 id="provision" className="text-2xl font-medium">
            Provision a pod
          </h2>
          <p className="max-w-2xl muted">
            Provisioning is idempotent: sending the same manifest again updates the pod and keeps its identifier and key.
          </p>
          <ProvisionForm templates={templates} />
        </section>
      </main>
    </div>
  );
}
