'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, EmptyState, Stat } from '@passport/ui-kit';
import { LocalTime } from '@/components/LocalTime';
import { BandDot, ErrorLine, Loading } from '../../circulation/_components/bits';
import { TenderForm } from '../../circulation/_components/TenderForm';
import { api, gw, type MyEnterprise, type PendingTender } from '../../circulation/_lib/api';
import { exposureBand, formatCredits, formatDollars } from '../../circulation/_lib/format';

/** Exposure (balance against ceiling) and sales whose dollar leg is not yet recorded (`/reconcile/pending`). */
export function ExposureTab({ slug, unit, enterprise }: { slug: string; unit: string; enterprise: MyEnterprise }) {
  const [pending, setPending] = useState<PendingTender[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ pending: PendingTender[] }>(slug, gw('/reconcile/pending'));
    if (!res.ok) {
      setError(res.message);
      setPending([]);
    } else {
      setPending(res.data.pending.filter((p) => p.payee === enterprise.did));
    }
  }, [slug, enterprise.did]);

  useEffect(() => {
    void load();
  }, [load]);

  const { balance, ceiling, pct } = enterprise.exposure;
  const band = exposureBand(pct);

  return (
    <div className="grid gap-8">
      <Card>
        <div className="grid gap-6 sm:grid-cols-3">
          <Stat label="Balance" value={formatCredits(balance, unit)} hint="Credits you hold to spend locally." />
          <Stat label="Ceiling" value={formatCredits(ceiling, unit)} hint="You stop accepting credits at this point." />
          <Stat
            label="Ceiling used"
            value={<BandDot band={band} label={`${Math.round(pct * 100)}%`} />}
            hint={band === 'hot' ? 'Spend some credits with local suppliers to make room.' : undefined}
          />
        </div>
      </Card>

      <section className="grid gap-3" aria-labelledby="unreconciled">
        <h3 id="unreconciled" className="text-lg font-medium">
          Dollars not yet recorded
        </h3>
        <ErrorLine message={error} />
        {pending === null ? (
          <Loading />
        ) : pending.length === 0 ? (
          <EmptyState title="All reconciled" body="Every paid sale has its dollar leg recorded." />
        ) : (
          <ul className="grid gap-3">
            {pending.map((p) => (
              <li key={p.transactionId}>
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span>
                      {formatCredits(p.amount.value, p.amount.unit || unit)}
                      {p.totalSale ? ` of ${formatDollars(p.totalSale.value)}` : ''}
                      {p.dollarsDue !== null ? ` · ${formatDollars(p.dollarsDue)} due` : ''}
                      {p.createdAt ? (
                        <span className="text-sm muted">
                          {' '}
                          · <LocalTime iso={p.createdAt} />
                        </span>
                      ) : null}
                    </span>
                    <Button variant="secondary" size="sm" onClick={() => setOpen(open === p.transactionId ? null : p.transactionId)}>
                      {open === p.transactionId ? 'Close' : 'Record tender'}
                    </Button>
                  </div>
                  {open === p.transactionId ? (
                    <div className="mt-4">
                      <TenderForm slug={slug} transactionId={p.transactionId} dollarsDue={p.dollarsDue ?? 0} onRecorded={() => void load()} />
                    </div>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
