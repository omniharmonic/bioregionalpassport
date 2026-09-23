'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, EmptyState, Pill, Stat } from '@passport/ui-kit';
import { LocalTime } from '@/components/LocalTime';
import { api, enterpriseNames, gw, type AccountView, type DirectoryEntry, type StatementEntry } from '../_lib/api';
import { abbreviateDid, formatCredits, formatDollars, formatShare, formatSignedCredits } from '../_lib/format';
import { ErrorLine, Loading } from './bits';

type State =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; account: AccountView; entries: StatementEntry[] };

/** My account: balance/limit/available, open-account button, statement, and where credits are accepted. */
export function MemberAccount({ slug, unit, base }: { slug: string; unit: string; base: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [directory, setDirectory] = useState<DirectoryEntry[] | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ account: AccountView; entries: StatementEntry[] }>(slug, gw('/accounts/me/statement'));
    if (res.ok) setState({ kind: 'ready', account: res.data.account, entries: res.data.entries });
    else if (res.code === 'NO_ACCOUNT') setState({ kind: 'none' });
    else setState({ kind: 'error', message: res.message });
  }, [slug]);

  useEffect(() => {
    void load();
    void api<{ entries: DirectoryEntry[] }>(slug, '/api/appview/directory?acceptsLocalCredit=true').then((res) =>
      setDirectory(res.ok ? res.data.entries : []),
    );
  }, [slug, load]);

  async function openAccount() {
    setOpening(true);
    setOpenError(null);
    const res = await api<{ account: AccountView }>(slug, gw('/accounts/open'), { method: 'POST' });
    setOpening(false);
    if (!res.ok) return setOpenError(res.message);
    await load();
  }

  const names = directory ? enterpriseNames(directory) : {};
  const counterparty = (e: StatementEntry) => {
    const did = e.direction === 'in' ? e.payer : e.payee;
    return did ? (names[did] ?? abbreviateDid(did)) : 'unknown';
  };
  const q = `pod=${encodeURIComponent(slug)}`;

  return (
    <div className="grid gap-10">
      <section aria-labelledby="my-account" className="grid gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="my-account" className="text-2xl font-medium">
            My account
          </h2>
          <div className="flex flex-wrap gap-3">
            <Button href={`/wallet/earn?${q}`} variant="secondary">
              Earn
            </Button>
            <Button href={`/wallet/pay?${q}`}>Pay</Button>
          </div>
        </div>

        {state.kind === 'loading' ? <Loading /> : null}
        {state.kind === 'error' ? <ErrorLine message={state.message} /> : null}
        {state.kind === 'none' ? (
          <Card>
            <div className="grid gap-4">
              <p>You do not have a credit account here yet. Opening one is free; it starts at zero with a limit set by your standing.</p>
              <ErrorLine message={openError} />
              <div>
                <Button onClick={openAccount} disabled={opening}>
                  {opening ? 'Opening…' : 'Open my account'}
                </Button>
              </div>
            </div>
          </Card>
        ) : null}
        {state.kind === 'ready' ? (
          <Card>
            <div className="grid gap-6 sm:grid-cols-3">
              <Stat label="Balance" value={formatCredits(state.account.balance, unit)} hint="Below zero means you owe the community." />
              <Stat label="Limit" value={formatCredits(state.account.limit, unit)} hint={`How far below zero you may go${state.account.band ? ` (band ${state.account.band})` : ''}.`} />
              <Stat label="Available" value={formatCredits(state.account.available, unit)} hint="What you can spend right now." />
            </div>
          </Card>
        ) : null}
      </section>

      {state.kind === 'ready' ? (
        <section aria-labelledby="statement" className="grid gap-4">
          <h2 id="statement" className="text-2xl font-medium">
            Statement
          </h2>
          {state.entries.length === 0 ? (
            <EmptyState title="No payments yet" body="When you pay or are paid in credits, each one shows up here with its receipt." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="muted">
                    <th scope="col" className="py-2 pr-4 font-medium">Date</th>
                    <th scope="col" className="py-2 pr-4 font-medium">With</th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">Amount</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Invoice</th>
                    <th scope="col" className="py-2 font-medium">Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {state.entries.map((e) => (
                    <tr key={e.id} className="border-t rule">
                      <td className="py-2 pr-4">{e.createdAt ? <LocalTime iso={e.createdAt} withTime={false} /> : '—'}</td>
                      <td className="py-2 pr-4">
                        {counterparty(e)}
                        {e.totalSale ? <span className="muted"> · sale {formatDollars(e.totalSale.value)}</span> : null}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{formatSignedCredits(e.amount, e.direction, e.unit ?? unit)}</td>
                      <td className="py-2 pr-4">
                        <code className="text-xs">{e.invoice ?? '—'}</code>
                      </td>
                      <td className="py-2">
                        <a href={`${base}/circulation/receipt/${encodeURIComponent(e.receiptId ?? e.id)}`}>View</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      <section aria-labelledby="where" className="grid gap-4">
        <h2 id="where" className="text-2xl font-medium">
          Where credits are accepted
        </h2>
        {directory === null ? (
          <Loading />
        ) : directory.length === 0 ? (
          <EmptyState title="No enterprises accept credits yet" body="When a local enterprise opens Merchant Mode it appears here." />
        ) : (
          <ul className="flex snap-x gap-4 overflow-x-auto pb-2">
            {directory.map((d) => (
              <li key={d.uri} className="min-w-[14rem] max-w-[16rem] shrink-0 snap-start">
                <Card>
                  <div className="grid gap-2">
                    <h3 className="font-medium">{d.record.name ?? 'Unnamed enterprise'}</h3>
                    {d.record.categories?.length ? <p className="text-sm muted">{d.record.categories.join(', ')}</p> : null}
                    {typeof d.record.acceptanceShare === 'number' ? (
                      <div>
                        <Pill tone="accent">Up to {formatShare(d.record.acceptanceShare)} in credits</Pill>
                      </div>
                    ) : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
