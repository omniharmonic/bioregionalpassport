'use client';

import { useState } from 'react';
import { Button, Card, Field, Input, Notice } from '@passport/ui-kit';
import { ENDORSEMENT_SCOPES, type ContactRow, type VouchScope } from '@passport/pod-client';
import { useWalletState } from '../_lib/WalletContext';
import { Did, ErrorNotice, useAction, vouchGiven } from '../_lib/ui';

/** After meeting: a local nickname, and an optional vouch (scope lives-here / worked-with / knows). */
export function VouchPrompt({ contact, onDone }: { contact: ContactRow; onDone?: () => void }) {
  const w = useWalletState();
  const [name, setName] = useState(contact.name ?? '');
  const [scope, setScope] = useState<VouchScope | ''>('');
  const [saved, setSaved] = useState<string | null>(null);

  const save = useAction(async () => {
    await w.wallet!.updateContact(contact.did, name.trim() ? { name: name.trim() } : {});
    let queued = false;
    if (scope) {
      const ceremony = await w.ceremonyFor(contact.pod);
      queued = (await ceremony.vouch(contact.did, scope)).queued;
    }
    setSaved(scope ? (queued ? 'Saved. Your vouch will be delivered when you are back online.' : 'Saved, and your vouch is on its way to them.') : 'Saved.');
    await w.reload();
    onDone?.();
  });

  return (
    <Card className="grid gap-4">
      <div>
        <p className="eyebrow">New neighbor</p>
        <h2 className="mt-1 text-xl font-semibold">You met {name.trim() || 'a neighbor'}</h2>
        <p className="text-sm muted">
          You each hold both signed halves of this relationship. Their identifier here: <Did did={contact.did} />
        </p>
      </div>
      <Field label="What would you like to call them?" htmlFor="vp-name" hint="Only you see this name.">
        <Input id="vp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam from the seed swap" />
      </Field>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Would you like to vouch for them?</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="vp-scope" checked={scope === ''} onChange={() => setScope('')} /> Not now
        </label>
        {ENDORSEMENT_SCOPES.map((s) => (
          <label key={s} className="flex items-center gap-2 text-sm">
            <input type="radio" name="vp-scope" checked={scope === s} onChange={() => setScope(s)} /> I vouch {vouchGiven(s)}
          </label>
        ))}
      </fieldset>
      <ErrorNotice error={save.error} />
      {saved ? <Notice kind="success">{saved}</Notice> : null}
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => void save.run()} disabled={save.busy}>
          {scope ? 'Sign my vouch and save' : 'Save'}
        </Button>
        <Button variant="secondary" href={w.href('/wallet/events')}>
          Ask a convener to witness this
        </Button>
      </div>
    </Card>
  );
}
