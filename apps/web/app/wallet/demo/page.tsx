'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Card, Explain, Notice, PageHeader, TierBadge, type Tier } from '@passport/ui-kit';
import { Ceremony, PodClient, createWallet, openWallet, vacActions, withSession, type PodEvent, type Wallet } from '@passport/pod-client';
import type { VerifiableCredential } from '@passport/credential-core';
import type { BioregionManifest } from '@passport/tenant-config';
import { useWalletState } from '../_lib/WalletContext';
import { Did, ErrorNotice, Section, describeAction, formatDate, tierLabel, useAction } from '../_lib/ui';

const DEMO_DB = 'passport-demo-phone';
const NEIGHBOR_DB = 'passport-demo-neighbor';

/** Pods where the simulated phone may create real (demo) members: `NEXT_PUBLIC_DEMO_PODS`, default tenant-zero. */
const DEMO_PODS = (process.env['NEXT_PUBLIC_DEMO_PODS'] ?? 'tenant-zero')
  .split(',')
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makePhone(name: string, pod: { slug: string; manifest: BioregionManifest }): Promise<DemoPhone> {
  await openWallet({ name }).forget().catch(() => undefined);
  const wallet = await createWallet({ name });
  const persona = await wallet.mintPersona(pod.slug);
  await wallet.addPod(pod.manifest, persona.did);
  const client = new PodClient({ slug: pod.slug, manifest: pod.manifest, persona, db: wallet.db });
  return { wallet, client, ceremony: new Ceremony({ wallet, relay: client.relay(), pod: pod.slug }), did: persona.did };
}

interface DemoPhone {
  wallet: Wallet;
  client: PodClient;
  ceremony: Ceremony;
  did: string;
}

/**
 * Single-device demo: "Simulate a second phone". A second wallet (its own IndexedDB database) plays the other
 * person, using the real pod routes (`/api/vta/relay`, `/membership/apply`, `/membership/ack`). The second phone
 * never opens a session, so your own sign-in cookie is untouched. Witnessing still needs a real convener: the demo
 * convener panel appears only when your passport already holds `vwc:issue` for this pod; then the second phone meets
 * a simulated neighbor (the pod refuses a convener who is a party to the relationship). Available only on the demo
 * pods in `NEXT_PUBLIC_DEMO_PODS` (default `tenant-zero`), because the demo creates real members.
 */
export default function DemoPage() {
  const w = useWalletState();
  const [phone, setPhone] = useState<DemoPhone | null>(null);
  /** When you are the convener, the second phone meets this simulated neighbor instead (no one witnesses their own relationship). */
  const [neighbor, setNeighbor] = useState<DemoPhone | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [met, setMet] = useState(false);
  const [authorities, setAuthorities] = useState<string[]>([]);
  const [myDid, setMyDid] = useState<string | undefined>();
  const [events, setEvents] = useState<PodEvent[]>([]);
  const [eventId, setEventId] = useState('');
  const [vwc, setVwc] = useState<VerifiableCredential | null>(null);
  const [grant, setGrant] = useState<VerifiableCredential | null>(null);
  const [admitted, setAdmitted] = useState<{ tier: string; vacs: VerifiableCredential[]; explanation: string[] } | null>(null);
  const phoneRef = useRef<DemoPhone | null>(null);
  phoneRef.current = phone;
  const neighborRef = useRef<DemoPhone | null>(null);
  neighborRef.current = neighbor;

  const say = (line: string) => setLog((l) => [...l, line]);
  const canConvene = authorities.includes('vwc:issue');

  useEffect(() => {
    if (!w.wallet || !w.slug) return;
    void (async () => {
      setAuthorities(await w.wallet!.authorities(w.slug!));
      setMyDid((await w.wallet!.personaFor(w.slug!))?.did);
      try {
        setEvents(await (await w.clientFor()).events());
      } catch {
        setEvents([]);
      }
    })();
  }, [w]);

  const start = useAction(async () => {
    const pod = w.pod!;
    await neighborRef.current?.wallet.forget().catch(() => undefined);
    const p = await makePhone(DEMO_DB, pod);
    setPhone(p);
    setNeighbor(null);
    setLog([`The second phone joined ${pod.manifest.identity.name} as a visitor.`]);
    setMet(false);
    setVwc(null);
    setGrant(null);
    setAdmitted(null);
  });

  /** The second phone's relationship partner: your passport, or (when you will convene) a simulated neighbor. */
  const partnerDid = () => (neighborRef.current ? neighborRef.current.did : myDid!);

  const meet = useAction(async () => {
    const p = phoneRef.current!;
    let other: Ceremony;
    if (canConvene) {
      const n = await makePhone(NEIGHBOR_DB, w.pod!);
      setNeighbor(n);
      neighborRef.current = n;
      other = n.ceremony;
      say('You will be the convener, and no one witnesses their own relationship, so a simulated neighbor meets the second phone.');
    } else {
      other = await w.ceremonyFor();
    }
    const session = await p.ceremony.host();
    say(canConvene ? 'The second phone shows its code; the neighbor scans it.' : 'The second phone shows its code; your passport scans it.');
    const joined = await other.join(session.inviteJson);
    let hostDone = false;
    let joinDone = false;
    for (let i = 0; i < 30 && !(hostDone && joinDone); i++) {
      if (!hostDone && (await p.ceremony.pollHost(session))) {
        hostDone = true;
        say('The second phone checked the other half and signed its own back.');
      }
      if (!joinDone && (await other.pollJoin(joined))) joinDone = true;
      if (!(hostDone && joinDone)) await sleep(700);
    }
    if (!(hostDone && joinDone)) throw new Error('The relay did not answer in time; try again.');
    if (!canConvene) await w.wallet!.updateContact(p.did, { name: 'Second phone (demo)' });
    say('Both sides now hold both signed halves of the relationship.');
    setMet(true);
    await w.reload();
  });

  const convenedHere = events.filter(
    (e) => e.attestation && myDid && e.conveners.includes(myDid) && e.endsAt && Date.parse(e.endsAt) > Date.now() && (!e.startsAt || Date.parse(e.startsAt) - 3600_000 < Date.now()),
  );

  const startEvent = useAction(async () => {
    const client = await w.clientFor();
    const now = Date.now();
    const ev = await withSession(
      w.wallet!,
      client,
      () => client.createEvent({ title: 'Demo gathering', startsAt: new Date(now - 5 * 60_000).toISOString(), endsAt: new Date(now + 2 * 3600_000).toISOString() }),
      ['event:convene'],
    );
    setEvents(await client.events());
    setEventId(ev.id);
    say(`You started the attestation event “${ev.title}”.`);
  });

  const witness = useAction(async () => {
    const p = phoneRef.current!;
    const ev = events.find((e) => e.id === eventId)!;
    await p.ceremony.requestWitness(ev, partnerDid());
    say('The second phone tapped “I’m here” and asked the convener to witness.');
    const client = await w.clientFor();
    const mine = await w.ceremonyFor();
    const [req] = (await mine.listWitnessRequests(ev)).filter((r) => r.requester === p.did);
    if (!req) throw new Error('The witness request has not arrived yet; try again in a moment.');
    await withSession(w.wallet!, client, () => mine.witness(client, ev, req), ['vwc:issue']);
    say('You witnessed it as the convener; the pod issued a witness credential.');
    const got = await p.ceremony.pollWitnessResult(ev, partnerDid());
    if (!got) throw new Error('The witness credential has not reached the second phone yet; try again.');
    setVwc(got);
    say('The second phone received the witness credential.');
  });

  const apply = useAction(async () => {
    const p = phoneRef.current!;
    const c = await p.wallet.contact(partnerDid());
    const g = await p.client.apply(vwc!, c!.vrcOut!, c!.vrcIn!);
    await p.wallet.storeCredential(g, { pod: p.client.slug });
    setGrant(g);
    say('The second phone applied; the pod offered it membership.');
  });

  const accept = useAction(async () => {
    const p = phoneRef.current!;
    const r = await p.client.ack(grant!);
    await p.wallet.storeCredential(r.ackCredential, { pod: p.client.slug });
    await p.wallet.replaceVacs(p.client.slug, r.vacs);
    setAdmitted({ tier: r.member.tier, vacs: r.vacs, explanation: r.explanation });
    say('The second phone accepted with its own signature and received its permissions.');
  });

  const reset = useAction(async () => {
    await phoneRef.current?.wallet.forget();
    await neighborRef.current?.wallet.forget();
    setPhone(null);
    setNeighbor(null);
    setLog([]);
    setMet(false);
    setVwc(null);
    setGrant(null);
    setAdmitted(null);
  });

  if (!w.pod) return null;
  const manifest = w.pod.manifest;
  if (!DEMO_PODS.includes(w.pod.slug)) {
    return (
      <div className="grid gap-6">
        <PageHeader title="Simulate a second phone" />
        <Notice kind="info">The simulated second phone is only available on demo pods.</Notice>
      </div>
    );
  }

  return (
    <div className="grid gap-8">
      <PageHeader title="Simulate a second phone" subtitle="Demo mode: a pretend neighbor on this same device, for showing the ceremony with one phone." />
      <Notice kind="warning">
        This is a demonstration. The second phone is a separate passport stored in this browser; it talks to {manifest.identity.name} through the same
        real pod routes a real phone would.
      </Notice>

      <Section title="1. Start the second phone">
        <ErrorNotice error={start.error} />
        {phone ? (
          <p className="text-sm">
            Second phone ready. Its identifier: <Did did={phone.did} />
          </p>
        ) : (
          <div>
            <Button onClick={() => void start.run()} disabled={start.busy}>
              Simulate a second phone
            </Button>
          </div>
        )}
      </Section>

      {phone ? (
        <Section title="2. Meet">
          <ErrorNotice error={meet.error} />
          {met ? (
            <p className="text-sm">{neighbor ? 'The second phone and a simulated neighbor have met.' : 'You and the second phone have met.'}</p>
          ) : (
            <div>
              <Button onClick={() => void meet.run()} disabled={meet.busy}>
                {meet.busy ? 'Meeting…' : canConvene ? 'Let the second phone meet a neighbor' : 'Meet the second phone'}
              </Button>
            </div>
          )}
        </Section>
      ) : null}

      {met ? (
        <Section title="3. Witness">
          <Explain>A steward must witness a new relationship at an attestation event; the demo cannot do that on anyone’s behalf.</Explain>
          {canConvene ? (
            <Card className="grid gap-3">
              <p className="text-sm font-medium">Demo convener</p>
              <p className="text-sm">
                Your passport holds the authority to witness in {manifest.identity.name}, so you can play the convener for the second phone.
              </p>
              {convenedHere.length ? (
                <select
                  className="rounded-2xl px-3 py-2 text-sm"
                  style={{ background: 'var(--bp-bg)', color: 'var(--bp-fg)', border: '1px solid var(--bp-rule)' }}
                  value={eventId}
                  onChange={(e) => setEventId(e.target.value)}
                >
                  <option value="">Choose one of your events…</option>
                  {convenedHere.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.title} ({formatDate(e.startsAt, true)})
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-sm muted">You are not convening an event that is happening now.</p>
              )}
              {authorities.includes('event:convene') ? (
                <div>
                  <Button size="sm" variant="secondary" onClick={() => void startEvent.run()} disabled={startEvent.busy}>
                    Start a demo attestation event now
                  </Button>
                </div>
              ) : null}
              <ErrorNotice error={startEvent.error ?? witness.error} />
              <div>
                <Button onClick={() => void witness.run()} disabled={!eventId || witness.busy || !!vwc}>
                  {vwc ? 'Witnessed' : 'Witness the second phone’s relationship'}
                </Button>
              </div>
            </Card>
          ) : (
            <Card className="grid gap-3 text-sm">
              <p>Take this relationship to an attestation event: on the Events page, tap “I’m here” and a convener can witness it.</p>
              <div>
                <Button variant="secondary" href={w.href('/wallet/events')}>
                  Go to events
                </Button>
              </div>
            </Card>
          )}
        </Section>
      ) : null}

      {vwc ? (
        <Section title="4. The second phone becomes a member">
          <ErrorNotice error={apply.error ?? accept.error} />
          {admitted ? (
            <Card className="grid gap-3">
              <div className="flex items-center justify-between gap-3">
                <p className="font-medium">The second phone went from Visitor to {tierLabel(manifest, admitted.tier)}.</p>
                <TierBadge tier={admitted.tier as Tier} name={tierLabel(manifest, admitted.tier)} />
              </div>
              <ul className="grid gap-1 text-sm">
                {admitted.explanation.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
              <ul className="grid gap-1 text-sm muted">
                {[...new Set(admitted.vacs.flatMap(vacActions))].map((a) => (
                  <li key={a}>{describeAction(a)}</li>
                ))}
              </ul>
            </Card>
          ) : grant ? (
            <Card className="grid gap-3">
              <p className="text-sm">
                On the second phone, its owner sees the consent screen: membership of {manifest.identity.name}, valid until {formatDate(grant.validUntil)}.
              </p>
              <div>
                <Button onClick={() => void accept.run()} disabled={accept.busy}>
                  “I accept” (on the second phone)
                </Button>
              </div>
            </Card>
          ) : (
            <div>
              <Button onClick={() => void apply.run()} disabled={apply.busy}>
                Apply for membership from the second phone
              </Button>
            </div>
          )}
        </Section>
      ) : null}

      {log.length ? (
        <Card>
          <h2 className="text-sm font-semibold">What happened</h2>
          <ol className="mt-2 grid list-decimal gap-1 pl-5 text-sm">
            {log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ol>
        </Card>
      ) : null}

      {phone ? (
        <div>
          <Button variant="ghost" onClick={() => void reset.run()}>
            Put the second phone away (delete its demo passport)
          </Button>
        </div>
      ) : null}
    </div>
  );
}
