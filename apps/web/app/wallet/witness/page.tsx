'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button, Card, EmptyState, Explain, Field, Input, Notice, PageHeader, QrCode } from '@passport/ui-kit';
import { MEETING_TASK_CONTEXT, withSession, type ContactRow, type WitnessChannel, type WitnessRequest } from '@passport/pod-client';
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

/** The witness's side: a channel QR, the pairs that asked on it, one tap each. */
function WitnessPanel() {
  const w = useWalletState();
  const [session, setSession] = useState<WitnessChannel | null>(null);
  const [requests, setRequests] = useState<WitnessRequest[]>([]);
  const [placeName, setPlaceName] = useState('');
  const [done, setDone] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);

  useEffect(() => {
    if (session || started.current || !w.slug) return;
    started.current = true;
    (async () => {
      try {
        const ceremony = await w.ceremonyFor();
        setSession(await ceremony.hostWitness());
      } catch (e) {
        setError(e);
      } finally {
        started.current = false;
      }
    })();
  }, [session, w]);

  usePoll(
    async () => {
      if (!session) return;
      const ceremony = await w.ceremonyFor();
      setRequests(await ceremony.listPeerWitnessRequests(session));
    },
    3000,
    !!session,
  );

  const witness = useAction(async (req: WitnessRequest) => {
    if (!session) return;
    const client = await w.clientFor();
    const ceremony = await w.ceremonyFor();
    const name = placeName.trim();
    await withSession(w.wallet!, client, () => ceremony.witnessPeer(client, session, req, name ? { place: { name } } : {}), ['vwc:issue']);
    setDone((d) => [...d, req.edgeDigest]);
    setRequests(await ceremony.listPeerWitnessRequests(session));
  });

  return (
    <Section title="Your witness code" aside={done.length ? <span className="text-sm muted">{done.length === 1 ? '1 relationship witnessed' : `${done.length} relationships witnessed`}</span> : undefined}>
      <ErrorNotice error={error} />
      <Card className="grid justify-items-center gap-4 text-center">
        {session ? (
          <>
            <QrCode value={session.inviteJson} size={260} />
            <p className="text-sm">After the two of them have met, each scans this code from “Ask a neighbor to witness”.</p>
            <details className="w-full text-left text-sm">
              <summary className="cursor-pointer">Their camera won’t work?</summary>
              <p className="mt-2 muted">Send them this code to paste instead:</p>
              <textarea readOnly className="mt-2 w-full rounded-2xl p-2 text-xs" rows={4} value={session.inviteJson} onFocus={(e) => e.currentTarget.select()} />
            </details>
          </>
        ) : (
          <p role="status" className="muted">
            Making your witness code…
          </p>
        )}
      </Card>

      <Field label="Where are you? (optional)" htmlFor="wt-place" hint="Recorded with the meeting; only stewards and the two people see it.">
        <Input id="wt-place" value={placeName} onChange={(e) => setPlaceName(e.target.value)} placeholder="e.g. Saturday farmers market" />
      </Field>

      <ErrorNotice error={witness.error} />
      {session && requests.length === 0 ? (
        <p role="status" className="text-sm muted">
          No one has asked yet. Pairs appear here as they scan your code.
        </p>
      ) : (
        <ul className="grid gap-3">
          {requests.map((r) => (
            <li key={r.edgeDigest}>
              <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                <span className="text-sm">
                  <Did did={r.vrcA.issuer} /> and <Did did={r.vrcB.issuer} />
                  <span className="block text-xs muted">asked {formatDate(r.createdAt, true)}</span>
                </span>
                <Button onClick={() => void witness.run(r)} disabled={witness.busy}>
                  I saw these two people together
                </Button>
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

/** The two neighbors' side: pick the relationship, scan the witness's code, wait for the result. */
function AskPanel({ contacts, onChanged }: { contacts: ContactRow[]; onChanged: () => Promise<void> }) {
  const w = useWalletState();
  const [picked, setPicked] = useState<string>('');
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const waiting = contacts.filter((c) => !c.vwc && c.witnessRequested?.event === MEETING_TASK_CONTEXT);
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
      for (const c of waiting) if (await ceremony.pollPeerWitnessResult(c.did)) got = true;
      if (got) {
        setNote('Witnessed. You can now use this relationship below.');
        await onChanged();
        await w.reload();
      }
    },
    3000,
    waiting.length > 0,
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
          <ul className="text-sm muted">
            {waiting.map((c) => (
              <li key={c.did}>
                {c.name ?? 'A neighbor'}
                {c.witnessRequested?.witness ? (
                  <>
                    {' '}
                    — witness <Did did={c.witnessRequested.witness} />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Section>
  );
}
