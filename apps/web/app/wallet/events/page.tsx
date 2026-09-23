'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, EmptyState, Explain, Field, Input, Notice, PageHeader, Pill } from '@passport/ui-kit';
import {
  applyForMembership,
  optInToIndex,
  withSession,
  type ContactRow,
  type PodEvent,
  type WitnessRequest,
} from '@passport/pod-client';
import type { VerifiableCredential } from '@passport/credential-core';
import { Consent } from '../_components/Consent';
import { useWalletState } from '../_lib/WalletContext';
import { Did, ErrorNotice, Section, formatDate, isToday, useAction, usePoll } from '../_lib/ui';

/** Upcoming attestation events; "I'm here"; the convener's witness queue; apply → consent → VACs. */
export default function EventsPage() {
  const w = useWalletState();
  const params = useSearchParams();
  const router = useRouter();
  const [events, setEvents] = useState<PodEvent[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [authorities, setAuthorities] = useState<string[]>([]);
  const selectedId = params?.get('event') ?? undefined;

  const load = useCallback(async () => {
    try {
      const client = await w.clientFor();
      setEvents(await client.events());
      setAuthorities(await w.wallet!.authorities(client.slug));
    } catch (e) {
      setError(e);
    }
  }, [w]);
  useEffect(() => {
    void load();
  }, [load, w.version]);

  const select = (id: string | undefined) => {
    const q = new URLSearchParams(params?.toString() ?? '');
    if (id) q.set('event', id);
    else q.delete('event');
    router.replace(`/wallet/events?${q.toString()}`);
  };

  if (!w.pod) return null;
  const now = Date.now();
  const upcoming = (events ?? []).filter((e) => !e.endsAt || Date.parse(e.endsAt) + 86_400_000 > now);
  const selected = upcoming.find((e) => e.id === selectedId) ?? (events ?? []).find((e) => e.id === selectedId);

  return (
    <div className="grid gap-8">
      <PageHeader title="Events" subtitle={`Attestation events in ${w.pod.manifest.identity.name}: where neighbors meet and are witnessed.`} />
      <ErrorNotice error={error} />
      {authorities.includes('event:convene') ? <ConveneForm onCreated={(id) => void load().then(() => select(id))} /> : null}
      {selected ? (
        <EventDetail event={selected} authorities={authorities} onBack={() => select(undefined)} />
      ) : events === null && !error ? (
        <p role="status" className="muted">
          Loading events…
        </p>
      ) : upcoming.length === 0 ? (
        <EmptyState title="No gatherings on the calendar" body="When a convener schedules an attestation event, it appears here." />
      ) : (
        <ul className="grid gap-3">
          {upcoming.map((e) => (
            <li key={e.id}>
              <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                <span>
                  <span className="font-medium">{e.title}</span>
                  <span className="block text-sm muted">{e.startsAt ? formatDate(e.startsAt, true) : 'Time to be announced'}</span>
                </span>
                <span className="flex items-center gap-2">
                  {e.attestation ? <Pill>Attestation event</Pill> : null}
                  <Button size="sm" variant="secondary" onClick={() => select(e.id)}>
                    Open
                  </Button>
                </span>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EventDetail({ event, authorities, onBack }: { event: PodEvent; authorities: string[]; onBack: () => void }) {
  const w = useWalletState();
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [member, setMember] = useState(false);
  const [personaDid, setPersonaDid] = useState<string | undefined>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [grant, setGrant] = useState<VerifiableCredential | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const wallet = w.wallet!;
    const [all, pair, persona] = await Promise.all([wallet.contacts(w.slug), wallet.membership(w.slug!), wallet.personaFor(w.slug!)]);
    setContacts(all);
    setMember(!!pair);
    setPersonaDid(persona?.did);
  }, [w.wallet, w.slug]);
  useEffect(() => {
    void refresh();
  }, [refresh, w.version]);

  // The other party of a witnessed pair learns about it from the same event channel.
  useEffect(() => {
    let live = true;
    void (async () => {
      const ceremony = await w.ceremonyFor();
      let got = false;
      for (const c of await w.wallet!.contacts(w.slug)) {
        if (!c.vwc && c.vrcIn && (await ceremony.pollWitnessResult(event, c.did).catch(() => undefined))) got = true;
      }
      if (got && live) await refresh();
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id]);

  const waiting = contacts.filter((c) => !c.vwc && c.witnessRequested?.event === event.id);
  const fresh = contacts.filter((c) => !c.vwc && c.vrcIn && c.witnessRequested?.event !== event.id && (isToday(c.formedAt) || c.event === event.id));
  const witnessed = contacts.filter((c) => c.vwc && c.vwc.credentialSubject?.['taskContext'] === event.id);
  const allWitnessed = contacts.filter((c) => c.vwc);

  const freshKey = fresh.map((c) => c.did).join(',');
  useEffect(() => {
    setPicked(new Set(freshKey ? freshKey.split(',') : []));
  }, [freshKey]);

  const ask = useAction(async () => {
    const ceremony = await w.ceremonyFor();
    let queued = 0;
    for (const did of picked) if ((await ceremony.requestWitness(event, did)).queued) queued++;
    setNote(queued ? 'You are offline: your request will be sent when you reconnect.' : 'Your request is with the convener.');
    await refresh();
  });

  usePoll(
    async () => {
      const ceremony = await w.ceremonyFor();
      let got = false;
      for (const c of waiting) if (await ceremony.pollWitnessResult(event, c.did)) got = true;
      if (got) {
        await refresh();
        await w.reload();
      }
    },
    3000,
    waiting.length > 0,
  );

  const apply = useAction(async (contactDid: string) => {
    const client = await w.clientFor();
    setGrant(await applyForMembership(w.wallet!, client, contactDid));
  });

  const optIn = useAction(async (contactDid: string) => {
    const client = await w.clientFor();
    const r = await optInToIndex(w.wallet!, client, contactDid, 'relationship');
    setNote(r.accepted ? 'Counted. The trust index will include this relationship next time it explains your tier.' : 'This relationship was already counted.');
    await refresh();
  });

  const isConvener = authorities.includes('vwc:issue') && !!personaDid && event.conveners.includes(personaDid);

  return (
    <div className="grid gap-8">
      <div className="grid gap-2">
        <button type="button" className="justify-self-start text-sm underline" onClick={onBack}>
          All events
        </button>
        <h2 className="text-2xl font-semibold">{event.title}</h2>
        <p className="text-sm muted">
          {event.startsAt ? formatDate(event.startsAt, true) : 'Time to be announced'}
          {event.endsAt ? ` – ${formatDate(event.endsAt, true)}` : ''}
          {event.placeId ? ` · ${event.placeId}` : ''}
        </p>
        {!event.attestation ? <Notice kind="info">This gathering is not an attestation event, so relationships cannot be witnessed here.</Notice> : null}
      </div>

      {note ? <Notice kind="success">{note}</Notice> : null}

      {grant ? (
        <Consent grant={grant} onDecline={() => setGrant(null)} onAccepted={() => void refresh()} />
      ) : (
        <>
          {event.attestation ? (
            <Section title="I’m here">
              {fresh.length === 0 && waiting.length === 0 ? (
                <Card className="grid gap-3">
                  <p className="text-sm">Meet someone here first: you each sign one half of your relationship, then ask the convener to witness it.</p>
                  <div>
                    <Button href={w.href('/wallet/meet')}>Meet a neighbor</Button>
                  </div>
                </Card>
              ) : null}
              {fresh.length > 0 ? (
                <Card className="grid gap-3">
                  <p className="text-sm font-medium">New relationships to witness</p>
                  {fresh.map((c) => (
                      <label key={c.did} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={picked.has(c.did)}
                          onChange={(e) => {
                            const next = new Set(picked);
                            if (e.target.checked) next.add(c.did);
                            else next.delete(c.did);
                            setPicked(next);
                          }}
                        />
                        {c.name ?? 'A neighbor'} <Did did={c.did} /> <span className="muted">met {formatDate(c.formedAt, true)}</span>
                      </label>
                    ))}
                  <ErrorNotice error={ask.error} />
                  <div>
                    <Button onClick={() => void ask.run()} disabled={ask.busy || picked.size === 0}>
                      I’m here — ask the convener to witness my new relationships
                    </Button>
                  </div>
                </Card>
              ) : null}
              {waiting.length > 0 ? (
                <Card className="grid gap-2">
                  <p role="status" className="text-sm">
                    Waiting for the convener to witness {waiting.length === 1 ? 'your relationship' : `${waiting.length} relationships`}…
                  </p>
                  <ul className="text-sm muted">
                    {waiting.map((c) => (
                      <li key={c.did}>{c.name ?? 'A neighbor'}</li>
                    ))}
                  </ul>
                </Card>
              ) : null}
            </Section>
          ) : null}

          {allWitnessed.length > 0 ? (
            <Section title="Witnessed">
              <ErrorNotice error={apply.error ?? optIn.error} />
              <ul className="grid gap-3">
                {(witnessed.length ? witnessed : allWitnessed).map((c) => (
                  <li key={c.did}>
                    <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                      <span>
                        <span className="font-medium">{c.name ?? 'A neighbor'}</span> <Pill>Witnessed</Pill>
                      </span>
                      {!member ? (
                        <Button onClick={() => void apply.run(c.did)} disabled={apply.busy}>
                          {apply.busy ? 'Applying…' : 'Apply for membership'}
                        </Button>
                      ) : c.committed?.some((x) => x.scope === 'relationship') ? (
                        <span className="text-sm muted">Counted in the trust index</span>
                      ) : (
                        <Button variant="secondary" onClick={() => void optIn.run(c.did)} disabled={optIn.busy}>
                          Count it toward my trust (opt in)
                        </Button>
                      )}
                    </Card>
                  </li>
                ))}
              </ul>
              {member ? (
                <Explain>The trust index only sees a salted fingerprint of this relationship, and only if you choose to count it.</Explain>
              ) : (
                <Explain>Applying asks the pod for membership; nothing is final until you accept it with your own signature.</Explain>
              )}
            </Section>
          ) : null}

          {authorities.includes('vwc:issue') ? (
            isConvener ? (
              <ConvenerQueue event={event} />
            ) : (
              <Notice kind="info">Only this event’s conveners can witness relationships here.</Notice>
            )
          ) : null}
        </>
      )}
    </div>
  );
}

/** Convener view (holders of `vwc:issue`): open witness requests, one tap each. */
function ConvenerQueue({ event }: { event: PodEvent }) {
  const w = useWalletState();
  const [requests, setRequests] = useState<WitnessRequest[]>([]);
  const [done, setDone] = useState<number>(0);

  usePoll(
    async () => {
      const ceremony = await w.ceremonyFor();
      setRequests(await ceremony.listWitnessRequests(event));
    },
    4000,
    true,
  );

  const witness = useAction(async (req: WitnessRequest) => {
    const client = await w.clientFor();
    const ceremony = await w.ceremonyFor();
    await withSession(w.wallet!, client, () => ceremony.witness(client, event, req), ['vwc:issue']);
    setDone((n) => n + 1);
    setRequests(await ceremony.listWitnessRequests(event));
  });

  const byRequester = useMemo(() => requests, [requests]);
  return (
    <Section title="Witness requests" aside={<span className="text-sm muted">{done ? `${done} witnessed` : 'You are a convener here'}</span>}>
      <ErrorNotice error={witness.error} />
      {byRequester.length === 0 ? (
        <p role="status" className="text-sm muted">
          No one is waiting. Requests appear here as people tap “I’m here”.
        </p>
      ) : (
        <ul className="grid gap-3">
          {byRequester.map((r) => (
            <li key={r.edgeDigest}>
              <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                <span className="text-sm">
                  <Did did={r.vrcA.issuer} /> and <Did did={r.vrcB.issuer} />
                  <span className="block text-xs muted">asked {formatDate(r.createdAt, true)}</span>
                </span>
                <Button onClick={() => void witness.run(r)} disabled={witness.busy}>
                  Witness (same event)
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Explain>Witness only people you saw meet here today; the pod records that you did.</Explain>
    </Section>
  );
}

/** Conveners (`event:convene`): start an attestation event. */
function ConveneForm({ onCreated }: { onCreated: (id: string) => void }) {
  const w = useWalletState();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [hours, setHours] = useState('3');
  const create = useAction(async () => {
    const client = await w.clientFor();
    const start = new Date();
    const ev = await withSession(
      w.wallet!,
      client,
      () =>
        client.createEvent({
          title: title.trim(),
          startsAt: new Date(start.getTime() - 5 * 60_000).toISOString(),
          endsAt: new Date(start.getTime() + Math.max(1, Number(hours) || 3) * 3600_000).toISOString(),
        }),
      ['event:convene'],
    );
    setOpen(false);
    setTitle('');
    onCreated(ev.id);
  });
  if (!open) {
    return (
      <div>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Start an attestation event now
        </Button>
      </div>
    );
  }
  return (
    <Card className="grid gap-3">
      <Field label="What is the gathering?" htmlFor="cv-title">
        <Input id="cv-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Creek cleanup at Wonderland Lake" />
      </Field>
      <Field label="How many hours will it run?" htmlFor="cv-hours">
        <Input id="cv-hours" type="number" min={1} max={12} value={hours} onChange={(e) => setHours(e.target.value)} />
      </Field>
      <ErrorNotice error={create.error} />
      <div className="flex gap-3">
        <Button onClick={() => void create.run()} disabled={create.busy || !title.trim()}>
          Start it
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
