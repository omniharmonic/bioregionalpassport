'use client';

import { useState, type FormEvent } from 'react';
import { Button, EmptyState, Field, Input, Pill } from '@passport/ui-kit';
import { formatCredits, formatDollars } from '../../circulation/_lib/format';

export interface RungUp {
  enterpriseDid: string;
  transactionId: string;
  invoice: string;
  credits: number;
  totalSale: number;
  status: 'waiting' | 'paid';
}

/**
 * Receipts: sales rung up on this screen, plus a lookup by transaction id or invoice. Each opens the signed
 * receipt page (owners and staff of the payee may read it).
 */
export function ReceiptsTab({ base, unit, rungUp }: { slug: string; base: string; unit: string; rungUp: RungUp[] }) {
  const [lookup, setLookup] = useState('');
  const href = (id: string) => `${base}/circulation/receipt/${encodeURIComponent(id)}`;

  function go(e: FormEvent) {
    e.preventDefault();
    if (lookup.trim()) window.location.href = href(lookup.trim());
  }

  return (
    <div className="grid gap-8">
      <section className="grid gap-3" aria-labelledby="rung-up">
        <h3 id="rung-up" className="text-lg font-medium">
          Rung up on this screen
        </h3>
        {rungUp.length === 0 ? (
          <EmptyState title="Nothing rung up yet" body="Sales you ring up here are listed until you leave the page." />
        ) : (
          <ul className="grid gap-2">
            {rungUp.map((r) => (
              <li key={r.transactionId} className="flex flex-wrap items-center justify-between gap-3 border-b rule py-2">
                <span>
                  {formatCredits(r.credits, unit)} of {formatDollars(r.totalSale)} · <code className="text-xs">{r.invoice}</code>{' '}
                  <Pill tone={r.status === 'paid' ? 'accent' : 'neutral'}>{r.status === 'paid' ? 'Paid' : 'Waiting'}</Pill>
                </span>
                {r.status === 'paid' ? <a href={href(r.transactionId)}>Receipt</a> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <form onSubmit={go} className="grid max-w-xl gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field label="Find a receipt" hint="Transaction id or invoice number." htmlFor="receipt-lookup">
          <Input id="receipt-lookup" value={lookup} onChange={(e) => setLookup(e.target.value)} />
        </Field>
        <Button type="submit" variant="secondary" disabled={!lookup.trim()}>
          Open
        </Button>
      </form>
    </div>
  );
}
