'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button, Card, Field, Notice, Pill, Textarea } from '@passport/ui-kit';
import { LocalTime } from '@/components/LocalTime';
import { api, gw, type ReceiptView as ReceiptData } from '../_lib/api';
import { abbreviateDid, formatCredits, formatDollars } from '../_lib/format';
import { ErrorLine, Loading } from './bits';

/** A signed payment receipt (`GET /api/gateway/pay/<id>/receipt`), with a way to raise a dispute. */
export function ReceiptView({ slug, id, unit }: { slug: string; id: string; unit: string }) {
  const [data, setData] = useState<ReceiptData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    void api<ReceiptData>(slug, gw(`/pay/${encodeURIComponent(id)}/receipt`)).then((res) => {
      if (res.ok) setData(res.data);
      else setError(res.message);
    });
  }, [slug, id]);

  if (error) return <ErrorLine message={error} />;
  if (!data) return <Loading />;
  const r = data.receipt;
  const credits = r.amount?.value ?? 0;
  const total = r.totalSale?.value;
  const dollars = typeof total === 'number' ? Math.max(0, Math.round((total - credits) * 100) / 100) : null;
  const when = r.createdAt ?? data.createdAt;

  return (
    <div className="grid gap-6">
      <Card>
        <dl className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <dt className="muted">Paid in credits</dt>
          <dd className="text-xl font-medium">{formatCredits(credits, r.amount?.unit ?? unit)}</dd>
          {typeof total === 'number' ? (
            <>
              <dt className="muted">Total sale</dt>
              <dd>{formatDollars(total)}</dd>
              <dt className="muted">Paid in dollars</dt>
              <dd>
                {dollars !== null ? formatDollars(dollars) : '—'}{' '}
                {data.externalTender ? <Pill tone="accent">Recorded{data.externalTender.provider ? ` · ${data.externalTender.provider}` : ''}</Pill> : <Pill>Not yet recorded</Pill>}
              </dd>
            </>
          ) : null}
          <dt className="muted">When</dt>
          <dd>{when ? <LocalTime iso={when} /> : '—'}</dd>
          <dt className="muted">From</dt>
          <dd>
            <code className="break-all text-sm">{abbreviateDid(r.payer)}</code>
          </dd>
          <dt className="muted">To</dt>
          <dd>
            <code className="break-all text-sm">{abbreviateDid(r.payee)}</code>
          </dd>
          <dt className="muted">Invoice</dt>
          <dd>
            <code className="text-sm">{r.invoice ?? '—'}</code>
          </dd>
          <dt className="muted">Transaction</dt>
          <dd>
            <code className="text-sm">{r.transactionId ?? id}</code>
          </dd>
        </dl>
      </Card>
      <div>
        <Button variant="ghost" size="sm" onClick={() => setShowRaw((v) => !v)} aria-expanded={showRaw}>
          {showRaw ? 'Hide the signed receipt' : 'Show the signed receipt'}
        </Button>
        {showRaw ? <pre className="mt-3 max-h-96 overflow-auto rounded-xl p-4 text-xs" style={{ background: 'color-mix(in srgb, var(--bp-fg) 6%, transparent)' }}>{JSON.stringify(r, null, 2)}</pre> : null}
      </div>
      <DisputeForm slug={slug} transactionId={r.transactionId ?? id} />
    </div>
  );
}

function DisputeForm({ slug, transactionId }: { slug: string; transactionId: string }) {
  const fid = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api(slug, gw('/disputes'), { method: 'POST', body: { transactionId, reason: reason.trim() } });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setDone(true);
  }

  if (done) return <Notice kind="success">Your dispute is with the stewards. They will be in touch.</Notice>;
  if (!open) {
    return (
      <p>
        Something wrong with this payment?{' '}
        <button type="button" className="underline" onClick={() => setOpen(true)}>
          Raise a dispute
        </button>
      </p>
    );
  }
  return (
    <form onSubmit={submit} className="grid max-w-xl gap-3">
      <Field label="What went wrong?" htmlFor={fid}>
        <Textarea id={fid} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required />
      </Field>
      <ErrorLine message={error} />
      <div>
        <Button type="submit" disabled={busy || !reason.trim()}>
          {busy ? 'Sending…' : 'Send to the stewards'}
        </Button>
      </div>
    </form>
  );
}
