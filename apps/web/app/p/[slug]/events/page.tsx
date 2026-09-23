import type { Metadata } from 'next';
import { withPod } from '@passport/db';
import { Card, EmptyState, Explain, PageHeader, Pill } from '@passport/ui-kit';
import { LocalTime } from '@/components/LocalTime';
import { db } from '@/lib/db';
import { loadPod } from '@/lib/pod';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Events' };

interface EventRow {
  id: string;
  title: string;
  starts_at: string | Date | null;
  ends_at: string | Date | null;
  place_id: string | null;
  conveners: unknown;
  attestation: boolean;
}

const iso = (v: string | Date | null): string | null => (v === null ? null : new Date(v).toISOString());

async function listEvents(slug: string): Promise<EventRow[] | null> {
  try {
    return await withPod(db(), slug, (tx) =>
      tx.query<EventRow>(
        `select id, title, starts_at, ends_at, place_id, conveners, attestation
           from events
          where ends_at is null or ends_at > now() - interval '1 day'
          order by starts_at asc nulls last
          limit 100`,
      ),
    );
  } catch (err) {
    console.error('[events] could not list events', err);
    return null;
  }
}

export default async function EventsPage({ params }: PageProps<'/p/[slug]/events'>) {
  const { slug } = await params;
  const pod = await loadPod(slug);
  const events = await listEvents(slug);

  return (
    <div className="grid gap-8">
      <PageHeader title="Events" subtitle={`Gatherings in ${pod.manifest.identity.name}.`} />
      <Explain>Attend one in person to become a member.</Explain>

      {events === null ? (
        <p role="status">Events are not available right now. Please try again in a moment.</p>
      ) : events.length === 0 ? (
        <EmptyState
          title="No gatherings are scheduled yet"
          body="Conveners post attestation events here. Check back soon, or ask a steward when the next one is."
        />
      ) : (
        <ul className="grid gap-5">
          {events.map((e) => {
            const starts = iso(e.starts_at);
            const conveners = Array.isArray(e.conveners) ? e.conveners.length : 0;
            return (
              <li key={e.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <h2 className="text-xl font-medium">{e.title}</h2>
                    {e.attestation ? <Pill>Attestation event</Pill> : null}
                  </div>
                  <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-[6rem_1fr]">
                    <dt className="muted">When</dt>
                    <dd>{starts ? <LocalTime iso={starts} /> : 'To be announced'}</dd>
                    <dt className="muted">Where</dt>
                    <dd>{e.place_id ?? 'To be announced'}</dd>
                    <dt className="muted">Conveners</dt>
                    <dd>
                      {conveners === 0 ? 'None named yet' : conveners === 1 ? '1 convener' : `${conveners} conveners`}
                    </dd>
                  </dl>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
