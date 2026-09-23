'use client';

import { useState } from 'react';
import { Button, Card, Explain, Field, Input, Notice, Textarea } from '@passport/ui-kit';
import { createShares, exportBackup } from '@passport/pod-client';
import { useWalletState } from '../_lib/WalletContext';
import { ErrorNotice, downloadText, useAction } from '../_lib/ui';

/** Passphrase backup download and the optional three recovery shares (principle 6: recoverable). */
export function RecoveryKit({ onDone, compact = false }: { onDone?: () => void; compact?: boolean }) {
  const w = useWalletState();
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [saved, setSaved] = useState(false);
  const [shares, setShares] = useState<string[] | null>(null);
  const mismatch = again.length > 0 && pass !== again;

  const backup = useAction(async () => {
    if (!w.wallet) return;
    if (pass !== again) throw new Error('The two passphrases are not the same.');
    const file = await exportBackup(w.wallet, pass);
    downloadText(file.filename, file.text);
    setSaved(true);
    setPass('');
    setAgain('');
  });

  const makeShares = useAction(async () => {
    if (!w.wallet) return;
    setShares(await createShares(w.wallet));
  });

  return (
    <div className="grid gap-5">
      <Card className="grid gap-4">
        <h3 className="text-lg font-semibold">Download an encrypted backup</h3>
        {!compact ? (
          <p className="text-sm">
            Your passport lives only on this device. A backup file, locked with a passphrase only you know, lets you restore it on a new phone.
          </p>
        ) : null}
        <Field label="Passphrase" htmlFor="bk-pass" hint="At least 8 characters. We cannot recover it for you.">
          <Input id="bk-pass" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </Field>
        <Field label="Passphrase again" htmlFor="bk-again" {...(mismatch ? { error: 'The two passphrases are not the same.' } : {})}>
          <Input id="bk-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </Field>
        <ErrorNotice error={backup.error} />
        {saved ? <Notice kind="success">Backup downloaded. Keep the file somewhere safe, away from this phone.</Notice> : null}
        <div>
          <Button onClick={() => void backup.run()} disabled={backup.busy || pass.length < 8 || pass !== again}>
            {backup.busy ? 'Encrypting…' : 'Download backup'}
          </Button>
        </div>
      </Card>

      <Card className="grid gap-4">
        <h3 className="text-lg font-semibold">Recovery shares (optional)</h3>
        <p className="text-sm">
          Split your keys into three shares and give one each to three people you trust. Any two of them can help you recover; one alone reveals nothing.
        </p>
        <ErrorNotice error={makeShares.error} />
        {shares ? (
          <div className="grid gap-3">
            {shares.map((s, i) => (
              <Field key={i} label={`Share ${i + 1} of 3`} htmlFor={`share-${i}`}>
                <Textarea id={`share-${i}`} readOnly value={s} rows={3} onFocus={(e) => e.currentTarget.select()} />
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(s)}>
                    Copy
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => downloadText(`passport-share-${i + 1}.txt`, s, 'text/plain')}>
                    Download
                  </Button>
                </div>
              </Field>
            ))}
            <Explain>Hand each share to a different person. Make new shares after you join another pod, so they cover its key too.</Explain>
          </div>
        ) : (
          <div>
            <Button variant="secondary" onClick={() => void makeShares.run()} disabled={makeShares.busy}>
              Make three shares
            </Button>
          </div>
        )}
      </Card>

      {onDone ? (
        <div className="flex flex-wrap gap-3">
          <Button onClick={onDone} disabled={!saved && !shares}>
            Continue
          </Button>
          {!saved && !shares ? (
            <Button variant="ghost" onClick={onDone}>
              Skip for now
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
