'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, EmptyState, Field, Input, Notice, Pill, Textarea } from '@passport/ui-kit';
import { LocalTime } from '@/components/LocalTime';
import { copyText, ErrorLine } from '../../circulation/_components/bits';
import { api, gw, type MyEnterprise } from '../../circulation/_lib/api';
import { abbreviateDid } from '../../circulation/_lib/format';

const MAX_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Staff (owner only). Staff authority is the owner's own authority to receive payments, passed on for at most
 * 30 days — only the owner's passport holds the key that can sign it, so this page prepares what to sign and
 * takes back the signed credential (`POST /api/gateway/merchant/enterprises/<did>/staff { vac }`).
 */
export function StaffTab({ slug, subject, enterprise, onChanged }: { slug: string; subject: string; enterprise: MyEnterprise; onChanged: () => void | Promise<void> }) {
  const [staffDid, setStaffDid] = useState('');
  const [days, setDays] = useState('14');
  const [payload, setPayload] = useState<string | null>(null);
  const [signed, setSigned] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const staff = enterprise.staff ?? [];
  const now = Date.now();
  const active = staff.filter((s) => !s.revokedAt && (!s.validUntil || Date.parse(s.validUntil) > now));
  const past = staff.filter((s) => !active.includes(s));

  function prepare(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const d = Number(days);
    if (!staffDid.trim().startsWith('did:')) return setError('Enter the staff member’s passport identifier (it starts with “did:”).');
    if (!Number.isInteger(d) || d < 1 || d > MAX_DAYS) return setError(`Staff authority may last between 1 and ${MAX_DAYS} days.`);
    const validFrom = new Date().toISOString();
    const validUntil = new Date(Date.now() + d * DAY_MS).toISOString();
    setPayload(
      JSON.stringify(
        {
          purpose: `Let this person receive payments at ${enterprise.name} for ${d} day${d === 1 ? '' : 's'}.`,
          attenuate: { scope: enterprise.did, actions: ['pay:receive'] },
          issuer: subject,
          subject: staffDid.trim(),
          validFrom,
          validUntil,
        },
        null,
        2,
      ),
    );
  }

  async function submitSigned(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let vac: unknown;
    try {
      vac = JSON.parse(signed);
    } catch {
      return setError('That does not look like a signed credential; paste the whole JSON your passport produced.');
    }
    setBusy(true);
    const res = await api<{ staff: { staffDid: string } }>(slug, gw(`/merchant/enterprises/${encodeURIComponent(enterprise.did)}/staff`), {
      method: 'POST',
      body: { vac, ...(staffDid.trim() ? { staffDid: staffDid.trim() } : {}) },
    });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setNotice(`${abbreviateDid(res.data.staff.staffDid)} can now ring up sales once they present their passport with this authority.`);
    setPayload(null);
    setSigned('');
    setStaffDid('');
    await onChanged();
  }

  async function remove(did: string) {
    setError(null);
    setNotice(null);
    const res = await api(slug, gw(`/merchant/enterprises/${encodeURIComponent(enterprise.did)}/staff/${encodeURIComponent(did)}`), { method: 'DELETE' });
    if (!res.ok) return setError(res.message);
    setNotice(`${abbreviateDid(did)} can no longer receive payments for ${enterprise.name}.`);
    await onChanged();
  }

  return (
    <div className="grid gap-8">
      <ErrorLine message={error} />
      {notice ? <Notice kind="success">{notice}</Notice> : null}

      <section className="grid gap-3" aria-labelledby="staff-current">
        <h3 id="staff-current" className="text-lg font-medium">
          Current staff
        </h3>
        {active.length === 0 ? (
          <EmptyState title="No staff yet" body="Add someone below so they can ring up sales when you are not at the till." />
        ) : (
          <ul className="grid gap-2">
            {active.map((s) => (
              <li key={s.digest} className="flex flex-wrap items-center justify-between gap-3 border-b rule py-2">
                <span>
                  <code className="text-sm">{abbreviateDid(s.staffDid)}</code>
                  {s.validUntil ? (
                    <span className="text-sm muted">
                      {' '}
                      · until <LocalTime iso={s.validUntil} withTime={false} />
                    </span>
                  ) : null}
                </span>
                <Button variant="danger" size="sm" onClick={() => void remove(s.staffDid)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {past.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-sm muted">Former staff ({past.length})</summary>
            <ul className="mt-2 grid gap-1 text-sm">
              {past.map((s) => (
                <li key={s.digest}>
                  <code>{abbreviateDid(s.staffDid)}</code> <Pill>{s.revokedAt ? 'Removed' : 'Expired'}</Pill>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section className="grid gap-4" aria-labelledby="staff-add">
        <h3 id="staff-add" className="text-lg font-medium">
          Add staff
        </h3>
        <form onSubmit={prepare} className="grid gap-4 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
          <Field label="Staff member’s passport identifier" htmlFor="staff-did">
            <Input id="staff-did" placeholder="did:key:…" value={staffDid} onChange={(e) => setStaffDid(e.target.value)} />
          </Field>
          <Field label={`Days (≤ ${MAX_DAYS})`} htmlFor="staff-days">
            <Input id="staff-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
          <Button type="submit" variant="secondary">
            Prepare
          </Button>
        </form>

        {payload ? (
          <Card>
            <div className="grid gap-4">
              <p>
                Your passport signs this, passing on your own authority to receive payments at {enterprise.name}. Open your passport,
                choose to share your authority for {enterprise.name}, and sign the request below. Then paste the signed credential here.
              </p>
              <pre className="max-h-72 overflow-auto rounded-xl p-4 text-xs" style={{ background: 'color-mix(in srgb, var(--bp-fg) 6%, transparent)' }}>
                {payload}
              </pre>
              <div>
                <Button variant="ghost" size="sm" onClick={async () => setCopied(await copyText(payload))}>
                  {copied ? 'Copied' : 'Copy request'}
                </Button>
              </div>
              <form onSubmit={submitSigned} className="grid gap-3">
                <Field label="Signed staff credential" htmlFor="staff-vac">
                  <Textarea id="staff-vac" rows={6} value={signed} onChange={(e) => setSigned(e.target.value)} className="font-mono text-xs" />
                </Field>
                <div>
                  <Button type="submit" disabled={busy || !signed.trim()}>
                    {busy ? 'Adding…' : 'Add staff'}
                  </Button>
                </div>
              </form>
            </div>
          </Card>
        ) : null}
      </section>
    </div>
  );
}
