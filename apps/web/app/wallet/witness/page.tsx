'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button, Card, EmptyState, Explain, Field, Input, Notice, PageHeader, QrCode } from '@passport/ui-kit';
import { PodError, matchCode, withSession, type ContactRow, type WitnessChannel, type WitnessRequest } from '@passport/pod-client';
import type { VerifiableCredential } from '@passport/credential-core';
import { Consent } from '../_components/Consent';
import { WitnessedList } from '../_components/WitnessedList';
import { useWalletState } from '../_lib/WalletContext';
import { Did, ErrorNotice, Section, formatDate, useAction, usePoll } from '../_lib/ui';
import { Scanner } from '../_lib/Scanner';

/**
 * Peer witnessing (Task 21c). Scheduled attestation events stay, but they are optional: any member holding
 * `vwc:issue` (a Trusted member when the pod's policy says so) can witness two neighbors on the spot.
 * - Witness: shows a witness-channel QR; the two neighbors scan it after they have met; their pair appears here;
 *   "I saw these two people together" asks the pod for the witness credential and hands it back on the channel.
 * - Neighbors: pick the relationship, scan the witness's code, and wait; then apply (or opt in) as after an event.
 */
export default function WitnessPage() {
  const w = useWalletState();
  const params = useSearchParams();
  const [authorities, setAuthorities] = useState<string[] | null>(null);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [member, setMember] = useState(false);
  const [grant, setGrant] = useState<VerifiableCredential | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const wallet = w.wallet;
    if (!wallet || !w.slug) return;
    const [auth, all, pair] = await Promise.all([wallet.authorities(w.slug), wallet.contacts(w.slug), wallet.membership(w.slug)]);
    setAuthorities(auth);
    setContacts(all);
    setMember(!!pair);
  }, [w.wallet, w.slug]);
  useEffect(() => {
    void refresh();
  }, [refresh, w.version]);

  if (!w.pod) return null;
  const canWitness = !!authorities?.includes('vwc:issue');
  const asking = params?.get('ask') === '1' || !canWitness;
  const witnessed = contacts.filter((c) => c.vwc);

  return (
    <div className="grid gap-8">
      <PageHeader
        title="Witness a relationship"
        subtitle={`In ${w.pod.manifest.identity.name}, a trusted neighbor can witness two people who have just met — no event needed.`}
      />
      {note ? <Notice kind="success">{note}</Notice> : null}
      {grant ? (
        <Consent grant={grant} onDecline={() => setGrant(null)} onAccepted={() => void refresh()} />
      ) : (
        <>
          {canWitness && !asking ? <WitnessPanel /> : null}
          <AskPanel contacts={contacts} onChanged={refresh} />
          <WitnessedList contacts={witnessed} member={member} onGrant={setGrant} onNote={setNote} onChanged={refresh} />
          {canWitness && asking ? (
            <div>
              <Button variant="secondary" href={w.href('/wallet/witness')}>
                Witness someone else’s relationship
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A new witness code every 10 minutes while the page is open; codes from the last hour are still polled. */
const ROTATE_MS = 10 * 60_000;
const KEEP_CHANNELS = 6;

interface Pending {
  req: WitnessRequest;
  session: WitnessChannel;
}

/** The witness's side: a channel QR, the pairs that asked on it, one tap each. */
function WitnessPanel() {
  const w = useWalletState();
  const [sessions, setSessions] = useState<WitnessChannel[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [placeName, setPlaceName] = useState('');
  const [done, setDone] = useState<string[]>([]);
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const current = sessions[sessions.length - 1];

  useEffect(() => {
    if (!w.slug) return;
    let live = true;
    const open = async () => {
      try {
        const ceremony = await w.ceremonyFor();
        const next = await ceremony.hostWitness();
        if (live) setSessions((prev) => [...prev, next].slice(-KEEP_CHANNELS));
      } catch (e) {
        if (live) setError(e);
      }
    };
    void open();
    const t = setInterval(() => void open(), ROTATE_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.slug]);

  const load = async () => {
    const ceremony = await w.ceremonyFor();
    const all: Pending[] = [];
    const seen = new Set<string>();
    for (const session of [...sessions].reverse()) {
      for (const req of await ceremony.listPeerWitnessRequests(session)) {
        if (seen.has(req.edgeDigest)) continue;
        seen.add(req.edgeDigest);
        all.push({ req, session });
      }
    }
    setPending(all);
  };
  usePoll(load, 3000, sessions.length > 0);

  const witness = useAction(async ({ req, session }: Pending) => {
    const client = await w.clientFor();
    const ceremony = await w.ceremonyFor();
    const name = placeName.trim();
    setNote(null);
    try {
      await withSession(w.wallet!, client, () => ceremony.witnessPeer(client, session, req, name ? { place: { name } } : {}), ['vwc:issue']);
      setDone((d) => [...d, req.edgeDigest]);
    } catch (e) {
      if (e instanceof PodError && e.code === 'ALREADY_WITNESSED') {
        // Someone else witnessed this pair first; the pod keeps one witness per pair.
        setDropped((d) => new Set(d).add(req.edgeDigest));
        setNote(`Another witness already confirmed the pair with code ${matchCode(req.edgeDigest)}, so there is nothing left for you to do.`);
        return;
      }
      throw e;
    }
    await load();
  });

  const shown = pending.filter((p) => !dropped.has(p.req.edgeDigest));

  return (
    <Section title="Your witness code" aside={done.length ? <span className="text-sm muted">{done.length === 1 ? '1 relationship witnessed' : `${done.length} relationships witnessed`}</span> : undefined}>
      <ErrorNotice error={error} />
      <Card className="grid justify-items-center gap-4 text-center">
        {current ? (
          <>
            <QrCode value={current.inviteJson} size={260} />
            <p className="text-sm">After the two of them have met, each scans this code from “Ask a neighbor to witness”. It changes every 10 minutes.</p>
            <details className="w-full text-left text-sm">
              <summary className="cursor-pointer">Their camera won’t work?</summary>
              <p className="mt-2 muted">Send them this code to paste instead:</p>
              <textarea readOnly className="mt-2 w-full rounded-2xl p-2 text-xs" rows={4} value={current.inviteJson} onFocus={(e) => e.currentTarget.select()} />
            </details>
          </>
        ) : (
          <p role="status" className="muted">
            Making your witness code…
          </p>
        )}
      </Card>

      <Field label="Where are you? (optional)" htmlFor="wt-place" hint="Recorded with the meeting; only stewards, you, and the two people see it.">
        <Input id="wt-place" value={placeName} onChange={(e) => setPlaceName(e.target.value)} placeholder="e.g. Saturday farmers market" />
      </Field>

      {note ? <Notice kind="info">{note}</Notice> : null}
      <ErrorNotice error={witness.error} />
      {current && shown.length === 0 ? (
        <p role="status" className="text-sm muted">
          No one has asked yet. Pairs appear here as they scan your code.
        </p>
      ) : (
        <ul className="grid gap-3">
          {shown.map((p) => (
            <li key={p.req.edgeDigest}>
              <Card className="grid gap-3 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <MatchCode edgeDigest={p.req.edgeDigest} />
                  <span className="text-sm">
                    <Did did={p.req.vrcA.issuer} /> and <Did did={p.req.vrcB.issuer} />
                    <span className="block text-xs muted">asked {formatDate(p.req.createdAt, true)}</span>
                  </span>
                </div>
                <p className="text-sm">Tap only if this code matches both of their phones.</p>
                <div>
                  <Button onClick={() => void witness.run(p)} disabled={witness.busy}>
                    I saw these two people together
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Explain>
        Witness only two people you have seen together, in person, just now. The pod records that you witnessed them, and stewards can see how many
        relationships each witness vouches for.
      </Explain>
    </Section>
  );
}

/** The relationship's matching code, large, so the witness and both neighbors can compare it at a glance. */
function MatchCode({ edgeDigest }: { edgeDigest: string }) {
  const code = matchCode(edgeDigest);
  return (
    <span aria-label={`Matching code ${code.split('').join(' ')}`} className="font-mono text-3xl font-semibold tracking-widest">
      {code}
    </span>
  );
}

/** The two neighbors' side: pick the relationship, scan the witness's code, wait for the result. */
function AskPanel({ contacts, onChanged }: { contacts: ContactRow[]; onChanged: () => Promise<void> }) {
  const w = useWalletState();
  const [picked, setPicked] = useState<string>('');
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const waiting = contacts.filter((c) => !c.vwc && (c.witnessChannels?.length ?? 0) > 0);
  // The other neighbor may never have scanned: their result arrives forwarded on the relationship channel.
  const listening = contacts.filter((c) => !c.vwc && c.vrcIn && c.channel);
  // Waiting relationships stay pickable, so a neighbor can ask a different witness if the first one left.
  const candidates = contacts.filter((c) => !c.vwc && c.vrcOut && c.vrcIn);
  const chosen = picked || candidates[0]?.did || '';

  const ask = useAction(async (code: string) => {
    const ceremony = await w.ceremonyFor();
    const r = await ceremony.requestPeerWitness(code, chosen);
    setScanning(false);
    setNote(r.queued ? 'You are offline: your request will be sent when you reconnect.' : 'Asked. Keep your phone open while your witness confirms.');
    await onChanged();
  });

  usePoll(
    async () => {
      const ceremony = await w.ceremonyFor();
      let got = false;
      for (const c of listening) if (await ceremony.pollPeerWitnessResult(c.did)) got = true;
      if (got) {
        setNote('Witnessed. You can now use this relationship below.');
        await onChanged();
        await w.reload();
      }
    },
    waiting.length > 0 ? 3000 : 10_000,
    listening.length > 0,
  );

  return (
    <Section title="Ask a neighbor to witness">
      {note ? <Notice kind="info">{note}</Notice> : null}
      {candidates.length === 0 && waiting.length === 0 ? (
        <EmptyState title="Nothing to witness yet" body="Meet someone first: you each sign one half of your relationship, then ask a trusted neighbor to witness it." />
      ) : null}
      {candidates.length === 0 && waiting.length === 0 ? (
        <div>
          <Button href={w.href('/wallet/meet')}>Meet a neighbor</Button>
        </div>
      ) : null}
      {candidates.length > 0 ? (
        <Card className="grid gap-3">
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">Which relationship?</legend>
            {candidates.map((c) => (
              <label key={c.did} className="flex items-center gap-2 text-sm">
                <input type="radio" name="ask-contact" checked={chosen === c.did} onChange={() => setPicked(c.did)} />
                {c.name ?? 'A neighbor'} <Did did={c.did} /> <span className="muted">met {formatDate(c.formedAt, true)}</span>
              </label>
            ))}
          </fieldset>
          <ErrorNotice error={ask.error} />
          {scanning ? (
            <Scanner onResult={(t) => void ask.run(t)} label="Or paste the witness’s code" />
          ) : (
            <div>
              <Button onClick={() => setScanning(true)} disabled={!chosen || ask.busy}>
                Scan the witness’s code
              </Button>
            </div>
          )}
          <Explain>Both of you should scan the same witness’s code, so each phone receives the result.</Explain>
        </Card>
      ) : null}
      {waiting.length > 0 ? (
        <Card className="grid gap-2">
          <p role="status" className="text-sm">
            Waiting for your witness to confirm {waiting.length === 1 ? 'your relationship' : `${waiting.length} relationships`}…
          </p>
          <p className="text-sm">Show your witness this code; it must match the one on their screen and on your neighbor’s phone.</p>
          <ul className="grid gap-3 text-sm muted">
            {waiting.map((c) => (
              <li key={c.did} className="grid gap-1">
                {c.edgeDigest ? <MatchCode edgeDigest={c.edgeDigest} /> : null}
                <span>
                  {c.name ?? 'A neighbor'}
                  {c.witnessRequested?.witness ? (
                    <>
                      {' '}
                      — witness <Did did={c.witnessRequested.witness} />
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Section>
  );
}
