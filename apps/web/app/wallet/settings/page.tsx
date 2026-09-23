'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Explain, Field, Input, Notice, PageHeader, Textarea } from '@passport/ui-kit';
import { abbreviateDid, exportCredentialsJson, recoveryStatus, type OutboxRow } from '@passport/pod-client';
import type { VerifiableCredential } from '@passport/credential-core';
import { Consent } from '../_components/Consent';
import { ChoosePod } from '../_components/Onboarding';
import { RecoveryKit } from '../_components/RecoveryKit';
import { Restore } from '../_components/Restore';
import { useWalletState } from '../_lib/WalletContext';
import { ErrorNotice, Section, downloadText, formatDate, useAction } from '../_lib/ui';

/** Backup, shares, restore, export, pods and identifiers, outbox, add a credential, forget this device. */
export default function SettingsPage() {
  const w = useWalletState();
  const router = useRouter();
  const [status, setStatus] = useState<Awaited<ReturnType<typeof recoveryStatus>> | null>(null);
  const [outbox, setOutbox] = useState<OutboxRow[]>([]);
  const [joining, setJoining] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [paste, setPaste] = useState('');
  const [added, setAdded] = useState<string | null>(null);
  const [pendingGrant, setPendingGrant] = useState<VerifiableCredential | null>(null);

  useEffect(() => {
    if (!w.wallet) return;
    void recoveryStatus(w.wallet).then(setStatus);
    void w.wallet.db.outbox.orderBy('id').toArray().then(setOutbox);
  }, [w.wallet, w.version]);

  const exportCreds = useAction(async () => {
    const f = await exportCredentialsJson(w.wallet!);
    downloadText(f.filename, f.text);
  });

  const forget = useAction(async () => {
    await w.wallet!.forget();
    window.location.assign('/wallet');
  });

  const addCredential = useAction(async () => {
    let vc: VerifiableCredential;
    try {
      vc = JSON.parse(paste);
    } catch {
      throw new Error('That is not a credential.');
    }
    if (!vc || !Array.isArray(vc.type) || !vc.proof || typeof vc.issuer !== 'string') throw new Error('That is not a signed credential.');
    const pod = w.pods.find((p) => p.did === vc.issuer || p.personaDid === vc.credentialSubject?.id);
    const isGrant = vc.type.includes('MembershipCredential') && typeof vc.credentialSubject?.['digestMultibase'] !== 'string';
    if (isGrant && pod && vc.credentialSubject?.id === pod.personaDid) {
      // A membership grant handed over by the pod (e.g. the operator's first-steward bootstrap): it only becomes
      // membership once the person accepts it with their own signature.
      if (pod.slug !== w.slug) w.selectPod(pod.slug);
      setPendingGrant(vc);
      setPaste('');
      return;
    }
    await w.wallet!.storeCredential(vc, pod ? { pod: pod.slug } : {});
    setAdded(pod ? `Added to your ${pod.manifest.identity.name} credentials.` : 'Added.');
    setPaste('');
    await w.reload();
  });

  return (
    <div className="grid gap-10">
      <PageHeader title="Settings" subtitle="Your passport, your keys, your choices." />

      <Section title="Recovery">
        {status ? (
          status.newKeysSinceBackup > 0 ? (
            <Notice kind="warning">
              {status.backupAt ? `Your last backup (${formatDate(status.backupAt)}) is missing ${status.newKeysSinceBackup} newer key${status.newKeysSinceBackup === 1 ? '' : 's'}.` : 'You have not downloaded a backup yet.'}
            </Notice>
          ) : (
            <Notice kind="success">Your backup from {formatDate(status.backupAt)} covers every key.</Notice>
          )
        ) : null}
        <RecoveryKit compact />
      </Section>

      <Section title="Restore">
        <Restore />
      </Section>

      <Section title="Your pods">
        <ul className="grid gap-3">
          {w.pods.map((p) => (
            <li key={p.slug}>
              <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                <span>
                  <span className="font-medium">{p.manifest.identity.name}</span>
                  <span className="block text-xs muted">Your identifier here: {abbreviateDid(p.personaDid)}</span>
                </span>
                {p.slug === w.slug ? (
                  <span className="text-sm muted">Showing now</span>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => w.selectPod(p.slug)}>
                    Switch to it
                  </Button>
                )}
              </Card>
            </li>
          ))}
        </ul>
        {joining ? (
          <ChoosePod exclude={w.pods.map((p) => p.slug)} onChoose={(slug) => router.push(`/wallet/join/${slug}`)} />
        ) : (
          <div>
            <Button variant="secondary" onClick={() => setJoining(true)}>
              Join another pod
            </Button>
          </div>
        )}
      </Section>

      <Section title="Your credentials">
        <Card className="grid gap-3">
          <p className="text-sm">Download every credential you hold as JSON. It contains no keys.</p>
          <ErrorNotice error={exportCreds.error} />
          <div>
            <Button variant="secondary" onClick={() => void exportCreds.run()}>
              Export credentials
            </Button>
          </div>
        </Card>
        <Card className="grid gap-3">
          <Field label="Add a credential you were given" htmlFor="add-vc" hint="For example a membership grant or permissions a pod operator handed you.">
            <Textarea id="add-vc" rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} />
          </Field>
          <ErrorNotice error={addCredential.error} />
          {added ? <Notice kind="success">{added}</Notice> : null}
          {pendingGrant ? <Consent grant={pendingGrant} onDecline={() => setPendingGrant(null)} /> : null}
          <div>
            <Button variant="secondary" onClick={() => void addCredential.run()} disabled={!paste.trim()}>
              Add it
            </Button>
          </div>
        </Card>
      </Section>

      <Section title="Waiting to send">
        {outbox.length === 0 ? (
          <p className="text-sm muted">Nothing is waiting.</p>
        ) : (
          <Card className="grid gap-2">
            <ul className="grid gap-1 text-sm">
              {outbox.map((o) => (
                <li key={o.id}>
                  {o.label ?? o.url} <span className="muted">· {o.attempts} attempt{o.attempts === 1 ? '' : 's'}</span>
                </li>
              ))}
            </ul>
            <div>
              <Button size="sm" variant="secondary" onClick={() => void w.flushOutbox()}>
                Send now
              </Button>
            </div>
          </Card>
        )}
      </Section>

      <Section title="Forget this device">
        <Card className="grid gap-3">
          <p className="text-sm">
            This deletes your keys and credentials from this device. Without a backup or two recovery shares, they cannot be brought back.
          </p>
          <Field label='Type "forget" to confirm' htmlFor="forget">
            <Input id="forget" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          </Field>
          <ErrorNotice error={forget.error} />
          <div>
            <Button variant="danger" disabled={confirm.trim().toLowerCase() !== 'forget' || forget.busy} onClick={() => void forget.run()}>
              Forget this device
            </Button>
          </div>
        </Card>
        <Explain>Forgetting this device does not end your memberships; pods still hold your signed acknowledgements until they expire.</Explain>
      </Section>
    </div>
  );
}
