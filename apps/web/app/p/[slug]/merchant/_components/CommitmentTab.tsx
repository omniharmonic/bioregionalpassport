'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, Field, Notice, Textarea } from '@passport/ui-kit';
import { LocalTime } from '@/components/LocalTime';
import { ErrorLine } from '../../circulation/_components/bits';
import { api, gw, type MyEnterprise } from '../../circulation/_lib/api';

/** The enterprise's public commitment: what it will accept and spend credits on (`POST /api/gateway/merchant/commitment`). */
export function CommitmentTab({ slug, enterprise, onSaved }: { slug: string; enterprise: MyEnterprise; onSaved: () => void | Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const current = enterprise.commitment;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await api(slug, gw('/merchant/commitment'), { method: 'POST', body: { enterpriseDid: enterprise.did, text: text.trim() } });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setSaved(true);
    setText('');
    await onSaved();
  }

  return (
    <div className="grid max-w-2xl gap-6">
      {current ? (
        <Card>
          <p className="text-sm muted">
            Current commitment{current.signedAt ? (
              <>
                {' '}
                · <LocalTime iso={current.signedAt} withTime={false} />
              </>
            ) : null}
          </p>
          <p className="mt-2 whitespace-pre-line">{current.text}</p>
        </Card>
      ) : (
        <p className="muted">{enterprise.name} has not made a commitment yet.</p>
      )}
      <form onSubmit={submit} className="grid gap-3">
        <Field label="What we will accept and spend credits on" hint="Neighbors read this before they pay you in credits." htmlFor="commit-text">
          <Textarea id="commit-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <ErrorLine message={error} />
        {saved ? <Notice kind="success">Commitment published.</Notice> : null}
        <div>
          <Button type="submit" disabled={busy || !text.trim()}>
            {busy ? 'Publishing…' : current ? 'Publish a new commitment' : 'Publish commitment'}
          </Button>
        </div>
      </form>
    </div>
  );
}
