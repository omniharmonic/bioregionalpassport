'use client';

import { useState, type FormEvent } from 'react';
import { Button, Field, Input, Notice, Textarea } from '@passport/ui-kit';
import { roundApi } from '../_lib/api';

export function ProposeForm({ slug, roundId, unit, roundHref }: { slug: string; roundId: string; unit: string | null; roundHref: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const budget = Number(text('budget'));
    if (!Number.isFinite(budget) || budget <= 0) return setError('The budget must be a positive amount.');
    const body: Record<string, unknown> = { title: text('title'), budget };
    if (text('summary')) body['summary'] = text('summary');
    if (text('place')) body['placeId'] = text('place');
    setBusy(true);
    setError(null);
    const res = await roundApi(slug, `/rounds/${encodeURIComponent(roundId)}/proposals`, { method: 'POST', body });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    window.location.assign(roundHref);
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-5">
      <Field label="Title" htmlFor="title">
        <Input id="title" name="title" required maxLength={200} />
      </Field>
      <Field label="Summary" htmlFor="summary" hint="What the project does and who it helps.">
        <Textarea id="summary" name="summary" rows={5} maxLength={5000} />
      </Field>
      <Field label={`Budget${unit ? ` (${unit})` : ''}`} htmlFor="budget">
        <Input id="budget" name="budget" type="number" min="0.01" step="0.01" required inputMode="decimal" />
      </Field>
      <Field label="Place" htmlFor="place" hint="Optional: where the work happens (a place from the map, or a short description).">
        <Input id="place" name="place" maxLength={200} />
      </Field>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Submit proposal'}
        </Button>
        <Button variant="ghost" href={roundHref}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
