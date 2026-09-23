import type { Metadata } from 'next';
import { listRecords } from '@passport/appview';
import { withPod } from '@passport/db';
import { Card, EmptyState, Explain, PageHeader, Pill } from '@passport/ui-kit';
import { db } from '@/lib/db';
import { loadPod, type LoadedPod } from '@/lib/pod';
import { currentPodBase } from '@/lib/podRequest';
import { withAppview } from '../directory/_lib/appview';
import { mergeGatherings, type EventRecordRow, type VtaEventRow } from './_lib/merge';
import { podDateTime, podTimeZone } from './_lib/podTime';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Events' };

/** Attestation events convened through the pod VTA. */
async function listVtaEvents(slug: string): Promise<VtaEventRow[] | null> {
  try {
    return await withPod(db(), slug, (tx) =>
      tx.query<VtaEventRow>(
        `select id, title, starts_at, ends_at, place_id, conveners, attestation
           from events
          where ends_at is null or ends_at > now() - interval '1 day'
          order by starts_at asc nulls last
          limit 100`,
      ),
    );
  } catch (err) {
    console.error('[events] could not list pod events', err);
    return null;
  }
}

/** `event` open records in the AppView (seeded demo gatherings and member posts). */
async function listRecordEvents(pod: LoadedPod): Promise<EventRecordRow[] | null> {
  try {
    const page = await withAppview(pod, (ctx) => listRecords(ctx, 'event', { limit: 100 }));
    return page.rows.map((r) => ({ uri: r.uri, record: r.record }));
  } catch (err) {
    console.error('[events] could not list event records', err);
    return null;
  }
}

export default async function EventsPage({ params }: PageProps<'/p/[slug]/events'>) {
  const { slug } = await params;
  const pod = await loadPod(slug);
  const [vta, records, base] = await Promise.all([listVtaEvents(slug), listRecordEvents(pod), currentPodBase(slug)]);
  const tz = podTimeZone(pod.manifest);
  const events = vta === null && records === null ? null : mergeGatherings(vta ?? [], records ?? []);

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
          {events.map((e) => (
            <li key={e.key} id={e.key} className="scroll-mt-24">
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h2 className="text-xl font-medium">{e.title}</h2>
                  {e.attestation ? <Pill>Attestation gathering</Pill> : null}
                </div>
                {e.description ? <p className="mt-2">{e.description}</p> : null}
                <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-[6rem_1fr]">
                  <dt className="muted">When</dt>
                  <dd>{e.startsAt ? <time dateTime={e.startsAt}>{podDateTime(e.startsAt, tz)}</time> : 'To be announced'}</dd>
                  <dt className="muted">Where</dt>
                  <dd>{e.location ?? 'To be announced'}</dd>
                  <dt className="muted">Conveners</dt>
                  <dd>{e.conveners === 0 ? 'None named yet' : e.conveners === 1 ? '1 convener' : `${e.conveners} conveners`}</dd>
                </dl>
                {e.uri && e.mappable && pod.manifest.modules.map ? (
                  <p className="mt-3 text-sm">
                    <a href={`${base}/map?focus=${encodeURIComponent(e.uri)}`}>Show on the map</a>
                  </p>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
