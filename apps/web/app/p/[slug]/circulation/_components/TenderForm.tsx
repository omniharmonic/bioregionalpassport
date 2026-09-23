'use client';

import { useId, useState, type FormEvent } from 'react';
import { Button, Field, Input, Notice, Select } from '@passport/ui-kit';
import { api, gw } from '../_lib/api';
import { formatDollars } from '../_lib/format';
import { ErrorLine } from './bits';

const PROVIDERS = [
  { value: 'manual', label: 'Cash, card or other (manual)' },
  { value: 'square', label: 'Square' },
  { value: 'clover', label: 'Clover' },
  { value: 'shopify', label: 'Shopify' },
] as const;

/** "Record tender": notes the dollar leg of a paid sale (`POST /api/gateway/pay/<id>/tender`). */
export function TenderForm({
  slug,
  transactionId,
  dollarsDue,
  staffVac,
  onRecorded,
}: {
  slug: string;
  transactionId: string;
  dollarsDue: number;
  /** Staff only: their passed-on authority for the enterprise. */
  staffVac?: Record<string, unknown> | undefined;
  onRecorded?: () => void;
}) {
  const id = useId();
  const [provider, setProvider] = useState<string>('manual');
  const [ref, setRef] = useState('');
  const [dollars, setDollars] = useState(dollarsDue.toFixed(2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = Number(dollars);
    if (!Number.isFinite(value) || value < 0) {
      setError('The dollar amount must be zero or more.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await api<{ externalTender: { ref?: string } }>(slug, gw(`/pay/${encodeURIComponent(transactionId)}/tender`), {
      method: 'POST',
      body: { provider, dollars: value, ...(ref.trim() ? { ref: ref.trim() } : {}), ...(staffVac ? { staffVac } : {}) },
    });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setDone(`Recorded ${formatDollars(value)}${res.data.externalTender?.ref ? ` (reference ${res.data.externalTender.ref})` : ''}.`);
    onRecorded?.();
  }

  if (done) return <Notice kind="success">{done}</Notice>;

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-3 sm:items-end">
      <Field label="Paid with" htmlFor={`${id}-p`}>
        <Select id={`${id}-p`} value={provider} onChange={(e) => setProvider(e.target.value)}>
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Dollars collected" htmlFor={`${id}-d`}>
        <Input id={`${id}-d`} inputMode="decimal" value={dollars} onChange={(e) => setDollars(e.target.value)} />
      </Field>
      <Field label="Reference (optional)" hint="Receipt or order number on your till." htmlFor={`${id}-r`}>
        <Input id={`${id}-r`} value={ref} onChange={(e) => setRef(e.target.value)} />
      </Field>
      <div className="sm:col-span-3 grid gap-3">
        <ErrorLine message={error} />
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? 'Recording…' : 'Record tender'}
          </Button>
        </div>
      </div>
    </form>
  );
}
