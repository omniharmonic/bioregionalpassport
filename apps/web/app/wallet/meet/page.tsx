'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Card, Explain, Notice, PageHeader, QrCode } from '@passport/ui-kit';
import type { HostSession, JoinSession, Met } from '@passport/pod-client';
import { VouchPrompt } from '../_components/VouchPrompt';
import { useWalletState } from '../_lib/WalletContext';
import { ErrorNotice, usePoll } from '../_lib/ui';
import { Scanner } from '../_lib/Scanner';

type Tab = 'host' | 'scan';

/** F2 front half: "Meet a neighbor" — show your code, or scan theirs; both sign one half of the relationship. */
export default function MeetPage() {
  const w = useWalletState();
  const [tab, setTab] = useState<Tab>('host');
  const [host, setHost] = useState<HostSession | null>(null);
  const [join, setJoin] = useState<JoinSession | null>(null);
  const [met, setMet] = useState<Met | null>(null);
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);

  // Hosting: make an invite as soon as the Host tab is open.
  useEffect(() => {
    if (tab !== 'host' || host || met || !w.slug || started.current) return;
    started.current = true;
    (async () => {
      try {
        const c = await w.ceremonyFor();
        setHost(await c.host());
      } catch (e) {
        setError(e);
      } finally {
        started.current = false;
      }
    })();
  }, [tab, host, met, w]);

  usePoll(
    async () => {
      const c = await w.ceremonyFor();
      const r = host ? await c.pollHost(host) : join ? await c.pollJoin(join) : null;
      if (r) {
        setMet(r);
        setHost(null);
        setJoin(null);
        await w.reload();
      }
    },
    2000,
    !met && (!!host || !!join),
  );

  async function onScan(text: string) {
    setError(null);
    try {
      const c = await w.ceremonyFor();
      setJoin(await c.join(text));
    } catch (e) {
      setError(e);
    }
  }

  if (!w.pod) return null;
  const name = w.pod.manifest.identity.name;

  if (met) {
    return (
      <div className="grid gap-6">
        <PageHeader title="Meet a neighbor" />
        <VouchPrompt contact={met.contact} />
        <div>
          <Button
            variant="ghost"
            onClick={() => {
              setMet(null);
              setTab('host');
            }}
          >
            Meet someone else
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <PageHeader title="Meet a neighbor" subtitle={`In person, in ${name}. One of you shows a code, the other scans it.`} />
      <div role="tablist" className="flex gap-2">
        {(['host', 'scan'] as Tab[]).map((t) => (
          <Button key={t} role="tab" aria-selected={tab === t} variant={tab === t ? 'primary' : 'secondary'} onClick={() => setTab(t)}>
            {t === 'host' ? 'Show my code' : 'Scan their code'}
          </Button>
        ))}
      </div>
      <ErrorNotice error={error} />

      {tab === 'host' ? (
        <Card className="grid justify-items-center gap-4 text-center">
          {host ? (
            <>
              <QrCode value={host.inviteJson} size={260} />
              <p role="status" className="text-sm">
                Waiting for your neighbor to scan this…
              </p>
              <details className="w-full text-left text-sm">
                <summary className="cursor-pointer">Their camera won’t work?</summary>
                <p className="mt-2 muted">Send them this code to paste instead:</p>
                <textarea readOnly className="mt-2 w-full rounded-2xl p-2 text-xs" rows={4} value={host.inviteJson} onFocus={(e) => e.currentTarget.select()} />
              </details>
            </>
          ) : (
            <p role="status" className="muted">
              Making your code…
            </p>
          )}
        </Card>
      ) : join ? (
        <Card className="grid gap-3">
          <p role="status">{join.queued ? 'You are offline: your half is saved and will be sent when you reconnect.' : 'Sent. Waiting for your neighbor’s phone to answer…'}</p>
        </Card>
      ) : (
        <Card>
          <Scanner onResult={(t) => void onScan(t)} label="Or paste their code" />
        </Card>
      )}

      <Explain>Each phone signs one half of your relationship with its own key; nothing is recorded by the pod until a convener or a trusted neighbor witnesses it.</Explain>
      {w.pendingOutbox ? <Notice kind="info">Some messages are waiting for a connection.</Notice> : null}
    </div>
  );
}
