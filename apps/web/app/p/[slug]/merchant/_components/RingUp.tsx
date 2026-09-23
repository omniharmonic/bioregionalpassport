'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Card, Field, Input, Notice, QrCode, Stat } from '@passport/ui-kit';
import { ErrorLine } from '../../circulation/_components/bits';
import { TenderForm } from '../../circulation/_components/TenderForm';
import { api, gw, type MyEnterprise, type ReceiptView } from '../../circulation/_lib/api';
import { clampCredit, formatCountdown, formatCredits, formatDollars, formatShare, ringUp, secondsLeft } from '../../circulation/_lib/format';
import type { RungUp } from './ReceiptsTab';

interface PayRequest {
  request: { invoice: string; expires: string; amount: { unit: string; value: number }; totalSale: { unit: string; value: number } };
  qr: string;
  transactionId: string;
}

type Phase =
  | { kind: 'entry' }
  | { kind: 'waiting'; req: PayRequest }
  | { kind: 'expired'; req: PayRequest }
  | { kind: 'paid'; req: PayRequest; receipt: ReceiptView };

const POLL_MS = 2500;

/** The ring-up screen: total → proposed credit share → payment code → paid → record tender. */
export function RingUp({
  slug,
  unit,
  enterprise,
  staffVac,
  onRungUp,
  onSettled,
}: {
  slug: string;
  unit: string;
  enterprise: MyEnterprise;
  /** Staff only: their passed-on authority for this enterprise (owners send none). */
  staffVac?: Record<string, unknown> | undefined;
  onRungUp: (r: RungUp) => void;
  onSettled: () => void;
}) {
  const [total, setTotal] = useState('');
  const [credit, setCredit] = useState('');
  const [edited, setEdited] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'entry' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const settledRef = useRef(false);

  const rules = enterprise.rules;
  const totalN = Number(total);
  const proposal = ringUp({
    totalSale: Number.isFinite(totalN) ? totalN : 0,
    maxShare: rules?.maxShare ?? 0,
    ceiling: rules?.ceiling ?? 0,
    balance: enterprise.exposure.balance,
  });
  const creditN = edited ? clampCredit(Number(credit), proposal) : proposal.proposed;
  const dollarsDue = totalN > 0 ? Math.max(0, Math.round((totalN - creditN) * 100) / 100) : 0;
  // Callbacks from the parent change identity on every render; keep the polling effect independent of them.
  const callbacks = useRef({ onRungUp, onSettled });
  callbacks.current = { onRungUp, onSettled };

  // Countdown clock + receipt polling while a code is showing.
  useEffect(() => {
    if (phase.kind !== 'waiting') return;
    const req = phase.req;
    settledRef.current = false;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      if (settledRef.current) return;
      if (secondsLeft(req.request.expires) <= 0) {
        setPhase({ kind: 'expired', req });
        return;
      }
      const res = await api<ReceiptView>(slug, gw(`/pay/${encodeURIComponent(req.transactionId)}/receipt`));
      if (res.ok && !settledRef.current) {
        settledRef.current = true;
        setPhase({ kind: 'paid', req, receipt: res.data });
        callbacks.current.onRungUp({ enterpriseDid: enterprise.did, transactionId: req.transactionId, invoice: req.request.invoice, credits: req.request.amount.value, totalSale: req.request.totalSale.value, status: 'paid' });
        callbacks.current.onSettled();
      } else if (!res.ok && res.code !== 'NOT_SETTLED') {
        setError(res.message);
      }
    }, POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [phase, slug, enterprise.did]);

  async function showCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!(totalN > 0)) return setError('The total sale must be a dollar amount above zero.');
    if (!(creditN > 0)) return setError('This enterprise has reached its acceptance ceiling for now.');
    setBusy(true);
    const res = await api<PayRequest>(slug, gw('/pay/request'), {
      method: 'POST',
      body: { enterpriseDid: enterprise.did, totalSale: { unit: 'USD', value: totalN }, creditValue: creditN, ...(staffVac ? { staffVac } : {}) },
    });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setNow(Date.now());
    setPhase({ kind: 'waiting', req: res.data });
    onRungUp({ enterpriseDid: enterprise.did, transactionId: res.data.transactionId, invoice: res.data.request.invoice, credits: res.data.request.amount.value, totalSale: res.data.request.totalSale.value, status: 'waiting' });
  }

  function newSale() {
    setPhase({ kind: 'entry' });
    setTotal('');
    setCredit('');
    setEdited(false);
    setError(null);
  }

  if (!rules) return <Notice kind="warning">This enterprise has not set acceptance rules yet; the owner can set them under Rules.</Notice>;

  if (phase.kind === 'waiting' || phase.kind === 'expired') {
    const r = phase.req.request;
    const left = phase.kind === 'expired' ? 0 : secondsLeft(r.expires, now);
    const due = Math.max(0, Math.round((r.totalSale.value - r.amount.value) * 100) / 100);
    return (
      <Card>
        <div className="grid gap-6 sm:grid-cols-[auto_1fr] sm:items-center">
          <div className="justify-self-center" style={{ opacity: phase.kind === 'expired' ? 0.3 : 1 }}>
            <QrCode value={phase.req.qr} size={280} />
          </div>
          <div className="grid gap-4">
            <p className="text-xl">
              <strong>{formatCredits(r.amount.value, r.amount.unit || unit)}</strong> of a {formatDollars(r.totalSale.value)} sale at{' '}
              {enterprise.name}. Collect {formatDollars(due)} on your usual rails.
            </p>
            <p className="muted">Ask the customer to scan this with their passport and confirm the payment.</p>
            {phase.kind === 'expired' ? (
              <Notice kind="warning">This payment code has expired. Ring the sale up again.</Notice>
            ) : (
              <p role="timer" aria-live="off" className="text-lg tabular-nums">
                Expires in {formatCountdown(left)}
              </p>
            )}
            <p className="text-sm muted">
              Invoice <code>{r.invoice}</code>
            </p>
            <ErrorLine message={error} />
            <div>
              <Button variant={phase.kind === 'expired' ? 'primary' : 'ghost'} onClick={newSale}>
                {phase.kind === 'expired' ? 'Ring up again' : 'Cancel'}
              </Button>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  if (phase.kind === 'paid') {
    const r = phase.req.request;
    const due = Math.max(0, Math.round((r.totalSale.value - r.amount.value) * 100) / 100);
    return (
      <div className="grid gap-6">
        <Notice kind="success">
          Paid — {formatCredits(r.amount.value, r.amount.unit || unit)} received; collect {formatDollars(due)} on your usual rails.
        </Notice>
        <Card>
          <div className="grid gap-4">
            <h3 className="text-lg font-medium">Record tender</h3>
            <p className="text-sm muted">Note how the {formatDollars(due)} was paid so your books reconcile.</p>
            <TenderForm slug={slug} transactionId={phase.req.transactionId} dollarsDue={due} staffVac={staffVac} />
          </div>
        </Card>
        <div>
          <Button onClick={newSale}>New sale</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={showCode} className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Total sale (USD)" htmlFor="ring-total">
          <Input
            id="ring-total"
            inputMode="decimal"
            placeholder="40.00"
            value={total}
            onChange={(e) => setTotal(e.target.value)}
            className="text-2xl"
            autoFocus
          />
        </Field>
        <Field
          label={`Paid in credits (at most ${formatCredits(proposal.proposed, unit)})`}
          hint={`Up to ${formatShare(rules.maxShare)} of the sale${proposal.headroom < proposal.shareCap ? `, limited by your ceiling (${formatCredits(proposal.headroom, unit)} of room)` : ''}.`}
          htmlFor="ring-credit"
        >
          <Input
            id="ring-credit"
            inputMode="decimal"
            value={edited ? credit : String(proposal.proposed)}
            onChange={(e) => {
              setEdited(true);
              setCredit(e.target.value);
            }}
            onBlur={() => edited && setCredit(String(clampCredit(Number(credit), proposal)))}
          />
        </Field>
      </div>
      <Card>
        <div className="grid gap-6 sm:grid-cols-3">
          <Stat label="Total sale" value={formatDollars(totalN > 0 ? totalN : 0)} />
          <Stat label="In credits" value={formatCredits(creditN, unit)} />
          <Stat label="In dollars" value={formatDollars(dollarsDue)} hint="Collected on your usual till." />
        </div>
      </Card>
      <ErrorLine message={error} />
      <div>
        <Button type="submit" size="lg" disabled={busy || !(totalN > 0) || !(creditN > 0)}>
          {busy ? 'Preparing…' : 'Show payment code'}
        </Button>
      </div>
    </form>
  );
}
