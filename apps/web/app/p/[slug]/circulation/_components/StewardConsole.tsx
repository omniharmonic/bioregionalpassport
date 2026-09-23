'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Card, EmptyState, Field, Input, Pill, Stat } from '@passport/ui-kit';
import { LocalTime } from '@/components/LocalTime';
import { api, gw } from '../_lib/api';
import { abbreviateDid, exposureBand, formatCredits } from '../_lib/format';
import { BandDot, bandStyle, ErrorLine, Loading } from './bits';

type KillStatus = 'ok' | 'warn' | 'breach';
interface Exposure {
  enterprises: { did: string; name: string; balance: number; ceiling: number; pct: number }[];
  reSpendRatio: number | null;
  reSpend: { ratio: number | null; inflow: number; outflow: number };
  volume: { count: number; sum: number };
  killCriteria: { id: string; status: KillStatus; detail: string }[];
}
interface Brokerage {
  queue: { needId: string; resourceSpec: string | null; quantity: unknown; enterprise: string | null }[];
  needs: number;
  offers: number;
}
interface Match {
  needId?: string;
  offerId?: string;
  note?: string | null;
  by?: string;
  at?: string;
  updatedAt?: string | null;
}
interface Flag {
  key: string;
  value: { flagged?: boolean; note?: string; [k: string]: unknown } | null;
  updatedAt: string | null;
}
interface Dispute {
  id: string;
  subjectDigest: string | null;
  filedBy: string | null;
  reason: string | null;
  status: string;
  createdAt: string | null;
}

const KILL_TITLES: Record<string, string> = {
  respend: 'Re-spend',
  ceilings: 'Acceptance ceilings',
  'unmet-demand': 'Unmet demand',
  counsel: 'Legal counsel',
};
const STATUS_LABEL: Record<KillStatus, string> = { ok: 'OK', warn: 'Watch', breach: 'Breach' };

const qty = (q: unknown): string => {
  if (q && typeof q === 'object' && 'value' in q) {
    const v = q as { value?: unknown; unit?: unknown };
    return `${String(v.value ?? '')} ${String(v.unit ?? '')}`.trim();
  }
  return q === null || q === undefined ? '' : String(q);
};

/** Circulation steward console: exposure heat-map, re-spend, kill criteria, brokerage, disputes, exports. */
export function StewardConsole({ slug, unit }: { slug: string; unit: string }) {
  const [exposure, setExposure] = useState<Exposure | null>(null);
  const [brokerage, setBrokerage] = useState<Brokerage | null>(null);
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [disputes, setDisputes] = useState<Dispute[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [year, setYear] = useState(String(new Date().getUTCFullYear()));

  const fail = (key: string, message: string | null) =>
    setErrors((e) => {
      const next = { ...e };
      if (message) next[key] = message;
      else delete next[key];
      return next;
    });

  const load = useCallback(async () => {
    const [ex, br, ma, fl, di] = await Promise.all([
      api<Exposure>(slug, gw('/steward/exposure')),
      api<Brokerage>(slug, gw('/steward/brokerage')),
      api<{ matches: Match[] }>(slug, gw('/steward/matches')),
      api<{ flags: Flag[] }>(slug, gw('/steward/flags')),
      api<{ disputes: Dispute[] }>(slug, '/api/vta/steward/disputes'),
    ]);
    if (ex.ok) setExposure(ex.data);
    fail('exposure', ex.ok ? null : ex.message);
    if (br.ok) setBrokerage(br.data);
    fail('brokerage', br.ok ? null : br.message);
    setMatches(ma.ok ? ma.data.matches : []);
    fail('matches', ma.ok ? null : ma.message);
    if (fl.ok) setFlags(fl.data.flags);
    setDisputes(di.ok ? di.data.disputes : []);
    fail('disputes', di.ok ? null : di.message);
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const counsel = flags.find((f) => f.key === 'counsel');
  const q = `pod=${encodeURIComponent(slug)}`;

  return (
    <div className="grid gap-12">
      <ErrorLine message={errors['exposure']} />
      {exposure === null && !errors['exposure'] ? <Loading /> : null}

      {exposure ? (
        <>
          <section aria-labelledby="health" className="grid gap-4">
            <h2 id="health" className="text-2xl font-medium">
              At a glance
            </h2>
            <Card>
              <div className="grid gap-6 sm:grid-cols-3">
                <Stat
                  label="Re-spend ratio"
                  value={exposure.reSpendRatio === null ? 'No ratio yet' : `${Math.round(exposure.reSpendRatio * 100)}%`}
                  hint={`Enterprises spent ${formatCredits(exposure.reSpend.outflow, unit)} of ${formatCredits(exposure.reSpend.inflow, unit)} earned (60 days).`}
                />
                <Stat label="Volume (30 days)" value={formatCredits(exposure.volume.sum, unit)} hint={`${exposure.volume.count} payments.`} />
                <Stat label="Enterprises" value={exposure.enterprises.length} hint="Accepting credits in this pod." />
              </div>
            </Card>
          </section>

          <section aria-labelledby="kill" className="grid gap-4">
            <h2 id="kill" className="text-2xl font-medium">
              Kill criteria
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2">
              {exposure.killCriteria.map((k) => (
                <li key={k.id} className="rounded-2xl p-5" style={bandStyle(k.status)}>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-medium">{KILL_TITLES[k.id] ?? k.id}</h3>
                    <BandDot band={k.status} label={STATUS_LABEL[k.status]} />
                  </div>
                  <p className="mt-2 text-sm">{k.detail}</p>
                  {k.id === 'counsel' ? <CounselToggle slug={slug} flagged={counsel?.value?.flagged === true} onChanged={load} /> : null}
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="heat" className="grid gap-4">
            <h2 id="heat" className="text-2xl font-medium">
              Exposure by enterprise
            </h2>
            {exposure.enterprises.length === 0 ? (
              <EmptyState title="No enterprises yet" body="Enterprises appear here once they register in Merchant Mode." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="muted">
                      <th scope="col" className="py-2 pr-4 font-medium">Enterprise</th>
                      <th scope="col" className="py-2 pr-4 text-right font-medium">Balance</th>
                      <th scope="col" className="py-2 pr-4 text-right font-medium">Ceiling</th>
                      <th scope="col" className="py-2 text-right font-medium">Used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exposure.enterprises.map((e) => {
                      const band = exposureBand(e.pct);
                      return (
                        <tr key={e.did} className="border-t rule">
                          <td className="py-2 pr-4">{e.name}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{formatCredits(e.balance, unit)}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{formatCredits(e.ceiling, unit)}</td>
                          <td className="py-2 text-right">
                            <span className="inline-block rounded-lg px-2 py-0.5 tabular-nums" style={bandStyle(band)}>
                              {Math.round(e.pct * 100)}%
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="mt-2 flex flex-wrap gap-4 text-xs muted">
                  <BandDot band="ok" label="under 50%" />
                  <BandDot band="warm" label="50–80%" />
                  <BandDot band="hot" label="over 80% (kill line if more than a third)" />
                </p>
              </div>
            )}
          </section>
        </>
      ) : null}

      <section aria-labelledby="broker" className="grid gap-4">
        <h2 id="broker" className="text-2xl font-medium">
          Brokerage queue
        </h2>
        <ErrorLine message={errors['brokerage']} />
        {brokerage === null ? (
          errors['brokerage'] ? null : <Loading />
        ) : (
          <>
            <p className="text-sm muted">
              {brokerage.needs} open needs, {brokerage.offers} offers. These needs have no matching offer yet — introduce someone who
              can help, then mark the match.
            </p>
            {brokerage.queue.length === 0 ? (
              <EmptyState title="Every need has a match" body="Nothing is waiting for an introduction." />
            ) : (
              <ul className="grid gap-3">
                {brokerage.queue.map((n) => (
                  <li key={n.needId}>
                    <Card>
                      <div className="grid gap-3">
                        <p>
                          <strong>{n.resourceSpec ?? 'Unspecified need'}</strong>
                          {qty(n.quantity) ? <span className="muted"> · {qty(n.quantity)}</span> : null}
                          {n.enterprise ? <span className="text-sm muted"> · {abbreviateDid(n.enterprise)}</span> : null}
                        </p>
                        <p className="text-xs muted">
                          Need <code>{n.needId}</code>
                        </p>
                        <MatchForm slug={slug} needId={n.needId} onDone={load} />
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="matches" className="grid gap-4">
        <h2 id="matches" className="text-2xl font-medium">
          Matches log
        </h2>
        <ErrorLine message={errors['matches']} />
        {matches === null ? (
          <Loading />
        ) : matches.length === 0 ? (
          <p className="muted">No matches logged yet.</p>
        ) : (
          <ul className="grid gap-2 text-sm">
            {matches.map((m) => (
              <li key={`${m.needId}-${m.offerId}`} className="border-b rule py-2">
                Need <code>{m.needId}</code> → offer <code>{m.offerId}</code>
                {m.note ? <span> · {m.note}</span> : null}
                {m.at ? (
                  <span className="muted">
                    {' '}
                    · <LocalTime iso={m.at} />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="disputes" className="grid gap-4">
        <h2 id="disputes" className="text-2xl font-medium">
          Disputes
        </h2>
        <ErrorLine message={errors['disputes']} />
        {disputes === null ? (
          <Loading />
        ) : disputes.length === 0 ? (
          <p className="muted">No disputes have been raised.</p>
        ) : (
          <ul className="grid gap-3">
            {disputes.map((d) => (
              <li key={d.id}>
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="font-medium">{d.reason ?? 'No reason given'}</span>
                    <Pill tone={d.status === 'open' ? 'accent' : 'neutral'}>{d.status === 'open' ? 'Open' : 'Adjudicated'}</Pill>
                  </div>
                  <p className="mt-2 text-xs muted">
                    Raised by <code>{abbreviateDid(d.filedBy)}</code> about <code className="break-all">{d.subjectDigest ?? '—'}</code>
                    {d.createdAt ? (
                      <>
                        {' '}
                        · <LocalTime iso={d.createdAt} />
                      </>
                    ) : null}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="exports" className="grid gap-4">
        <h2 id="exports" className="text-2xl font-medium">
          Exports
        </h2>
        <div className="flex flex-wrap items-end gap-4">
          <Button href={`${gw('/exports/transactions.csv')}?${q}`} variant="secondary">
            All transactions (CSV)
          </Button>
          <Field label="Tax year" htmlFor="tax-year" className="w-28">
            <Input id="tax-year" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} />
          </Field>
          <Button href={`${gw('/exports/1099b.json')}?${q}&year=${encodeURIComponent(year)}`} variant="secondary">
            Credits received per enterprise (1099-B worksheet, JSON)
          </Button>
        </div>
      </section>
    </div>
  );
}

function CounselToggle({ slug, flagged, onChanged }: { slug: string; flagged: boolean; onChanged: () => Promise<void> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api(slug, gw('/steward/flags'), {
      method: 'POST',
      body: { key: 'counsel', value: { flagged: !flagged, ...(note.trim() ? { note: note.trim() } : {}) } },
    });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setNote('');
    await onChanged();
  }

  return (
    <form onSubmit={toggle} className="mt-4 grid gap-3">
      <Field label={flagged ? 'Note on clearing the flag (optional)' : 'What counsel said (optional)'} htmlFor="counsel-note">
        <Input id="counsel-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <ErrorLine message={error} />
      <div>
        <Button type="submit" size="sm" variant={flagged ? 'secondary' : 'danger'} disabled={busy}>
          {flagged ? 'Clear the counsel flag' : 'Record a counsel concern'}
        </Button>
      </div>
    </form>
  );
}

function MatchForm({ slug, needId, onDone }: { slug: string; needId: string; onDone: () => Promise<void> }) {
  const [offerId, setOfferId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api(slug, gw('/steward/matches'), { method: 'POST', body: { needId, offerId: offerId.trim(), ...(note.trim() ? { note: note.trim() } : {}) } });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    await onDone();
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <Field label="Offer id" htmlFor={`offer-${needId}`}>
        <Input id={`offer-${needId}`} value={offerId} onChange={(e) => setOfferId(e.target.value)} />
      </Field>
      <Field label="Note (optional)" htmlFor={`note-${needId}`}>
        <Input id={`note-${needId}`} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Button type="submit" size="sm" disabled={busy || !offerId.trim()}>
        {busy ? 'Saving…' : 'Mark matched'}
      </Button>
      <div className="sm:col-span-3">
        <ErrorLine message={error} />
      </div>
    </form>
  );
}
