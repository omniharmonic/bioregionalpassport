'use client';

import { useEffect, useState } from 'react';
import { Button, Card, Explain, Notice, PageHeader } from '@passport/ui-kit';
import { abbreviateDid, checkPaymentRequest, parsePaymentRequest, payRequest } from '@passport/pod-client';
import { useWalletState } from '../_lib/WalletContext';
import { Scanner } from '../_lib/Scanner';
import { ErrorNotice, formatDate, useAction } from '../_lib/ui';

type Request = ReturnType<typeof parsePaymentRequest>;

/**
 * F7 Pay (wallet side): scan the merchant's payment request, see what it is, sign the authorization
 * (`org.bioregion.pay.authorization`, presentation bound to challenge = invoice) and submit it to
 * `/api/gateway/pay/authorize`; then the receipt.
 */
export default function PayPage() {
  const w = useWalletState();
  const [request, setRequest] = useState<Request | null>(null);
  const [scanError, setScanError] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<{ receipt: any; balance?: number } | null>(null);

  // Enterprise names from the pod directory (fetched once), so the merchant is shown by name when listed.
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const client = await w.clientFor();
        const r = await client.get<{ entries: { record?: { did?: string; name?: string } }[] }>('appview', '/directory');
        const map: Record<string, string> = {};
        for (const e of r.entries ?? []) if (e.record?.did && e.record.name) map[e.record.did] = e.record.name;
        if (live) setNames(map);
      } catch {
        // Without the directory the merchant is shown by its abbreviated identifier.
      }
    })();
    return () => {
      live = false;
    };
  }, [w]);
  const merchantName = (did: string) => names[did] ?? abbreviateDid(did);

  const pay = useAction(async () => {
    const client = await w.clientFor();
    setReceipt(await payRequest(w.wallet!, client, request!));
  });

  if (!w.pod) return null;
  const manifest = w.pod.manifest;
  const unit = manifest.currency.unit;
  if (!manifest.modules.circulation) return <Notice kind="info">{manifest.identity.name} does not use local credit.</Notice>;

  if (receipt) {
    const r = receipt.receipt ?? {};
    return (
      <div className="grid gap-6">
        <PageHeader title="Paid" />
        <Card className="grid gap-2">
          <p className="text-2xl font-semibold">
            {r.amount?.value} {r.amount?.unit ?? unit}
          </p>
          <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="muted">To</dt>
            <dd>{merchantName(r.payee)}</dd>
            <dt className="muted">Invoice</dt>
            <dd>{r.invoice}</dd>
            <dt className="muted">When</dt>
            <dd>{formatDate(r.createdAt, true)}</dd>
            <dt className="muted">Receipt</dt>
            <dd>{r.transactionId}</dd>
            {typeof receipt.balance === 'number' ? (
              <>
                <dt className="muted">Your balance</dt>
                <dd>
                  {receipt.balance} {unit}
                </dd>
              </>
            ) : null}
          </dl>
          {r.totalSale ? <p className="text-sm muted">Pay the rest of the {r.totalSale.value} {r.totalSale.unit} sale the usual way.</p> : null}
        </Card>
        <div>
          <Button
            variant="secondary"
            onClick={() => {
              setReceipt(null);
              setRequest(null);
            }}
          >
            Done
          </Button>
        </div>
      </div>
    );
  }

  if (request) {
    const rest = Math.max(0, Math.round((request.totalSale.value - request.amount.value) * 100) / 100);
    const problem = checkPaymentRequest(request, manifest);
    return (
      <div className="grid gap-6">
        <PageHeader title="Confirm payment" />
        <Card className="grid gap-3">
          <p className="text-3xl font-semibold">
            {request.amount.value} {request.amount.unit}
          </p>
          <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="muted">To</dt>
            <dd>{merchantName(request.merchant)}</dd>
            <dt className="muted">Sale total</dt>
            <dd>
              {request.totalSale.value} {request.totalSale.unit}
            </dd>
            <dt className="muted">Expires</dt>
            <dd>{formatDate(request.expires, true)}</dd>
          </dl>
          <Explain>
            You pay {request.amount.value} {request.amount.unit} of a {request.totalSale.value} {request.totalSale.unit} sale; the remaining {rest}{' '}
            {request.totalSale.unit} goes on the merchant’s usual payment.
          </Explain>
          {problem ? <Notice kind="error">{problem}</Notice> : null}
          <ErrorNotice error={pay.error} />
          <div className="flex flex-wrap gap-3">
            <Button size="lg" onClick={() => void pay.run()} disabled={pay.busy || !!problem}>
              {pay.busy ? 'Signing…' : 'Sign and pay'}
            </Button>
            <Button variant="ghost" onClick={() => setRequest(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <PageHeader title="Pay with credits" subtitle={`Scan the merchant’s code to pay part of a sale in ${unit}s.`} />
      <ErrorNotice error={scanError} />
      <Card>
        <Scanner
          label="Or paste the payment request"
          onResult={(text) => {
            try {
              setScanError(null);
              setRequest(parsePaymentRequest(text));
            } catch (e) {
              setScanError(e);
            }
          }}
        />
      </Card>
      <Explain>Credits are earned by offering something to your neighbors; they are never sold.</Explain>
    </div>
  );
}
