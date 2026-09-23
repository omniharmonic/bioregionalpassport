'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button, Card, Explain, Notice, PageHeader } from '@passport/ui-kit';
import { vacActions, type ContactRow, type CredentialRow } from '@passport/pod-client';
import { useWalletState } from '../../_lib/WalletContext';
import { describeAction, describeCredential, downloadText, formatDate } from '../../_lib/ui';

/** One credential: plain explanation plus the raw JSON (the only place full identifiers are shown). */
export default function CredentialPage() {
  const params = useParams<{ digest: string }>();
  const digest = decodeURIComponent(params?.digest ?? '');
  const w = useWalletState();
  const [row, setRow] = useState<CredentialRow | null | undefined>(undefined);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [mine, setMine] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!w.wallet) return;
    void (async () => {
      setRow((await w.wallet!.credential(digest)) ?? null);
      setContacts(await w.wallet!.contacts());
      setMine(new Set((await w.wallet!.identifiers()).map((i) => i.did)));
    })();
  }, [w.wallet, digest]);

  if (row === undefined) return null;
  if (row === null) return <Notice kind="error">This passport does not hold that credential.</Notice>;
  const manifest = w.pods.find((p) => p.slug === row.pod)?.manifest;
  const d = describeCredential(row, manifest, { nameOf: (did) => contacts.find((c) => c.did === did)?.name, mine: (did) => mine.has(did) });
  const actions = row.kind === 'authority' ? vacActions(row.raw) : [];
  const json = JSON.stringify(row.raw, null, 2);

  return (
    <div className="grid gap-6">
      <PageHeader title={d.title} subtitle={manifest ? manifest.identity.name : undefined} />
      <Explain>{d.explain}</Explain>
      {row.status === 'superseded' ? <Notice kind="info">A newer credential from the pod has replaced this one; it is kept for your records.</Notice> : null}
      <Card>
        <dl className="grid gap-2 text-sm sm:grid-cols-[8rem_1fr]">
          <dt className="muted">Type</dt>
          <dd>{row.type}</dd>
          <dt className="muted">Issued by</dt>
          <dd className="break-all">
            <code>{row.issuer}</code>
          </dd>
          <dt className="muted">About</dt>
          <dd className="break-all">
            <code>{row.subject}</code>
          </dd>
          <dt className="muted">Valid from</dt>
          <dd>{formatDate(row.raw.validFrom, true)}</dd>
          <dt className="muted">Valid until</dt>
          <dd>{row.validUntil ? formatDate(row.validUntil, true) : 'No end date'}</dd>
          <dt className="muted">Fingerprint</dt>
          <dd className="break-all">
            <code>{row.digest}</code>
          </dd>
        </dl>
      </Card>
      {actions.length ? (
        <Card>
          <h2 className="font-semibold">What it lets you do</h2>
          <ul className="mt-2 grid gap-1 text-sm">
            {actions.map((a) => (
              <li key={a}>{describeAction(a)}</li>
            ))}
          </ul>
        </Card>
      ) : null}
      <details>
        <summary className="cursor-pointer text-sm font-medium">The credential itself (JSON)</summary>
        <pre className="mt-3 overflow-x-auto rounded-2xl p-4 text-xs" style={{ background: 'color-mix(in srgb, var(--bp-fg) 6%, transparent)' }}>
          {json}
        </pre>
      </details>
      <div className="flex gap-3">
        <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(json)}>
          Copy JSON
        </Button>
        <Button variant="secondary" onClick={() => downloadText(`credential-${row.digest.slice(0, 12)}.json`, json)}>
          Download
        </Button>
      </div>
    </div>
  );
}
