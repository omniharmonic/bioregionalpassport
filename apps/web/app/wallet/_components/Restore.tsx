'use client';

import { useState } from 'react';
import { Button, Card, Field, Input, Notice, Textarea } from '@passport/ui-kit';
import { importBackup, recoverFromShares } from '@passport/pod-client';
import { useWalletState } from '../_lib/WalletContext';
import { ErrorNotice, useAction } from '../_lib/ui';

/** Restore from a backup file + passphrase, or from two recovery shares. */
export function Restore() {
  const w = useWalletState();
  const [file, setFile] = useState<File | null>(null);
  const [pass, setPass] = useState('');
  const [shareA, setShareA] = useState('');
  const [shareB, setShareB] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const fromFile = useAction(async () => {
    if (!w.wallet || !file) return;
    const r = await importBackup(w.wallet, file, pass);
    setDone(`Restored ${r.pods} pod${r.pods === 1 ? '' : 's'} and ${r.credentials} credential${r.credentials === 1 ? '' : 's'}.`);
    await w.reload();
  });
  const fromShares = useAction(async () => {
    if (!w.wallet) return;
    const r = await recoverFromShares(w.wallet, [shareA, shareB]);
    setDone(`Restored ${r.restored} key${r.restored === 1 ? '' : 's'}. Join your pods again to use them; your credentials come back from a backup file, and with keys alone a pod sees you as a visitor until a steward re-admits you.`);
    await w.reload();
  });

  return (
    <div className="grid gap-5">
      {done ? <Notice kind="success">{done}</Notice> : null}
      <Card className="grid gap-4">
        <h3 className="text-lg font-semibold">From a backup file</h3>
        <Field label="Backup file" htmlFor="rs-file">
          <input id="rs-file" type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label="Passphrase" htmlFor="rs-pass">
          <Input id="rs-pass" type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </Field>
        <ErrorNotice error={fromFile.error} />
        <div>
          <Button onClick={() => void fromFile.run()} disabled={!file || !pass || fromFile.busy}>
            {fromFile.busy ? 'Opening…' : 'Restore'}
          </Button>
        </div>
      </Card>
      <Card className="grid gap-4">
        <h3 className="text-lg font-semibold">From two recovery shares</h3>
        <Field label="First share" htmlFor="rs-a">
          <Textarea id="rs-a" rows={2} value={shareA} onChange={(e) => setShareA(e.target.value)} />
        </Field>
        <Field label="Second share" htmlFor="rs-b">
          <Textarea id="rs-b" rows={2} value={shareB} onChange={(e) => setShareB(e.target.value)} />
        </Field>
        <ErrorNotice error={fromShares.error} />
        <div>
          <Button onClick={() => void fromShares.run()} disabled={!shareA.trim() || !shareB.trim() || fromShares.busy}>
            Recover my keys
          </Button>
        </div>
      </Card>
    </div>
  );
}
