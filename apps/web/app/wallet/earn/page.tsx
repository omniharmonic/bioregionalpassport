'use client';

import { useState } from 'react';
import { Button, Card, Explain, Field, Input, Notice, PageHeader, Textarea } from '@passport/ui-kit';
import { withSession } from '@passport/pod-client';
import { copy } from '@passport/tenant-config';
import { useWalletState } from '../_lib/WalletContext';
import { ErrorNotice, useAction } from '../_lib/ui';

/** F8 Earn: "What can you offer?" → an `org.bioregion.offer` open record in the pod directory. */
export default function EarnPage() {
  const w = useWalletState();
  const [what, setWhat] = useState('');
  const [amount, setAmount] = useState('1');
  const [unit, setUnit] = useState('hour');
  const [when, setWhen] = useState('');
  const [about, setAbout] = useState('');
  const [posted, setPosted] = useState(false);

  const post = useAction(async () => {
    const client = await w.clientFor();
    const value = Number(amount);
    if (!what.trim()) throw new Error('Say what you can offer.');
    if (!(value > 0)) throw new Error('The amount must be a number above zero.');
    await withSession(w.wallet!, client, () =>
      client.postRecord('offer', {
        resourceSpec: what.trim(),
        quantity: { unit: unit.trim() || 'unit', value },
        ...(when.trim() ? { availability: when.trim() } : {}),
        ...(about.trim() ? { description: about.trim() } : {}),
      }),
    );
    setPosted(true);
    setWhat('');
    setAbout('');
  });

  if (!w.pod) return null;
  const manifest = w.pod.manifest;
  return (
    <div className="grid gap-6">
      <PageHeader title={copy(manifest, 'cta.earn')} subtitle={`Offer something to your neighbors in ${manifest.identity.name}; people pay you in ${manifest.currency.unit}s.`} />
      {posted ? (
        <Notice kind="success">
          Your offer is listed. <a href={`/p/${manifest.identity.slug}/directory`}>See it in the directory</a>.
        </Notice>
      ) : null}
      <Card className="grid gap-4">
        <Field label="What can you offer?" htmlFor="e-what" hint="For example: bike repair, sourdough starter, Spanish lessons.">
          <Input id="e-what" value={what} onChange={(e) => setWhat(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="How much" htmlFor="e-amt">
            <Input id="e-amt" type="number" min={0} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Of what" htmlFor="e-unit" hint="hour, loaf, session…">
            <Input id="e-unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
          </Field>
        </div>
        <Field label="When are you available? (optional)" htmlFor="e-when">
          <Input id="e-when" value={when} onChange={(e) => setWhen(e.target.value)} placeholder="Weekday evenings" />
        </Field>
        <Field label="Anything else? (optional)" htmlFor="e-about">
          <Textarea id="e-about" value={about} onChange={(e) => setAbout(e.target.value)} />
        </Field>
        <ErrorNotice error={post.error} />
        <div>
          <Button onClick={() => void post.run()} disabled={post.busy}>
            {post.busy ? 'Listing…' : 'List my offer'}
          </Button>
        </div>
      </Card>
      <Explain>Offers are open records anyone can read in the directory. You earn credits by offering; you never buy them.</Explain>
    </div>
  );
}
