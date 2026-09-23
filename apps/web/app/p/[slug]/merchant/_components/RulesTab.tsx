'use client';

import { useState, type FormEvent } from 'react';
import { Button, Field, Input, Notice } from '@passport/ui-kit';
import { ErrorLine } from '../../circulation/_components/bits';
import { api, gw, type MyEnterprise } from '../../circulation/_lib/api';
import { formatShare, unitLabel } from '../../circulation/_lib/format';

/** Acceptance rules (`PUT /api/gateway/merchant/enterprises/<did>/rules`). Owner only. */
export function RulesTab({
  slug,
  unit,
  enterprise,
  defaultAcceptance,
  onSaved,
}: {
  slug: string;
  unit: string;
  enterprise: MyEnterprise;
  defaultAcceptance: Record<string, number>;
  onSaved: () => void | Promise<void>;
}) {
  const r = enterprise.rules;
  const [share, setShare] = useState(String(Math.round((r?.maxShare ?? 0) * 1000) / 10));
  const [ceiling, setCeiling] = useState(String(r?.ceiling ?? 0));
  const [offline, setOffline] = useState(String(r?.offlineAllowance ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const def = r ? defaultAcceptance[r.category] : undefined;
  const units = unitLabel(unit, 2);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const pct = Number(share);
    const c = Number(ceiling);
    const o = Number(offline);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return setError('The maximum credit share must be between 0 and 100 percent.');
    if (!Number.isFinite(c) || c < 0) return setError('The ceiling must be a number of zero or more.');
    if (!Number.isFinite(o) || o < 0) return setError('The offline allowance must be a number of zero or more.');
    setBusy(true);
    const res = await api(slug, gw(`/merchant/enterprises/${encodeURIComponent(enterprise.did)}/rules`), {
      method: 'PUT',
      body: { maxShare: Math.round(pct * 10) / 1000, ceiling: c, offlineAllowance: o },
    });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setSaved(true);
    await onSaved();
  }

  return (
    <form onSubmit={submit} className="grid max-w-xl gap-5">
      <Field
        label="Maximum share of a sale in credits (%)"
        hint={typeof def === 'number' ? `The pod's default for ${r?.category} is ${formatShare(def)}.` : undefined}
        htmlFor="rules-share"
      >
        <Input id="rules-share" inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} />
      </Field>
      <Field label={`Ceiling (${units})`} hint="The most credits you will hold before you stop accepting them." htmlFor="rules-ceiling">
        <Input id="rules-ceiling" inputMode="decimal" value={ceiling} onChange={(e) => setCeiling(e.target.value)} />
      </Field>
      <Field label={`Offline allowance (${units} per day)`} hint="How much you accept while a customer's phone cannot reach the pod." htmlFor="rules-offline">
        <Input id="rules-offline" inputMode="decimal" value={offline} onChange={(e) => setOffline(e.target.value)} />
      </Field>
      <ErrorLine message={error} />
      {saved ? <Notice kind="success">Rules saved.</Notice> : null}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save rules'}
        </Button>
      </div>
    </form>
  );
}
