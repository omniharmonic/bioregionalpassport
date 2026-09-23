'use client';

import { digestMultibase } from '@passport/credential-core';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Field, Input, Notice, Select, Textarea, TierBadge, type Tier } from '@passport/ui-kit';
import { LocalTime } from '@/components/LocalTime';
import { errorMessage, stewardFetch } from './api';
import type { AnomalyFlag, Dispute, EventView, GovernanceLogEntry, StewardMember, VacLogEntry } from './types';

type Tab = 'flags' | 'members' | 'events' | 'authority' | 'disputes' | 'governance';

const TABS: { key: Tab; label: string }[] = [
  { key: 'flags', label: 'Flags' },
  { key: 'members', label: 'Members' },
  { key: 'events', label: 'Events' },
  { key: 'authority', label: 'Authority log' },
  { key: 'disputes', label: 'Disputes' },
  { key: 'governance', label: 'Governance log' },
];

const STEWARD_TIERS: Tier[] = ['T0', 'T1', 'T2'];

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav className="flex flex-wrap gap-1" aria-label="Steward console sections">
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          aria-current={active === t.key ? 'page' : undefined}
          onClick={() => onChange(t.key)}
          className="rounded-2xl px-3 py-2 text-sm font-medium transition-colors"
          style={{
            background: active === t.key ? 'color-mix(in srgb, var(--bp-primary) 15%, transparent)' : 'transparent',
            color: 'var(--bp-fg)',
            border: '1px solid color-mix(in srgb, var(--bp-fg) 12%, transparent)',
          }}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

export function StewardConsole({ slug, canConvene }: { slug: string; canConvene: boolean }) {
  const [tab, setTab] = useState<Tab>('flags');
  const base = `/api/vta`;

  return (
    <div className="grid gap-8">
      <TabBar active={tab} onChange={setTab} />
      {tab === 'flags' ? <FlagsTab /> : null}
      {tab === 'members' ? <MembersTab /> : null}
      {tab === 'events' ? <EventsTab base={base} canConvene={canConvene} /> : null}
      {tab === 'authority' ? <AuthorityLogTab /> : null}
      {tab === 'disputes' ? <DisputesTab /> : null}
      {tab === 'governance' ? <GovernanceLogTab /> : null}
      <p className="text-xs muted">Pod: {slug}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

function FlagsTab() {
  const [flags, setFlags] = useState<AnomalyFlag[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeNotice, setRecomputeNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await stewardFetch<{ flags: AnomalyFlag[] }>('/api/index/steward/flags');
      setFlags(data.flags);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function recompute() {
    setRecomputing(true);
    setRecomputeNotice(null);
    try {
      const res = await stewardFetch<{ total: number; counts: Record<string, number>; computedAt: string }>('/api/index/recompute', { method: 'POST' });
      setRecomputeNotice(`Recomputed ${res.total} member(s) at ${new Date(res.computedAt).toLocaleTimeString()}.`);
      await load();
    } catch (err) {
      setRecomputeNotice(errorMessage(err));
    } finally {
      setRecomputing(false);
    }
  }

  return (
    <div className="grid gap-5">
      <div className="flex items-center gap-3">
        <Button type="button" variant="secondary" size="sm" onClick={() => void recompute()} disabled={recomputing}>
          {recomputing ? 'Recomputing…' : 'Recompute'}
        </Button>
        {loading ? <span className="text-sm muted">Loading…</span> : null}
      </div>
      {recomputeNotice ? <Notice kind="info">{recomputeNotice}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {flags && flags.length === 0 ? <p>No anomaly flags right now. Flags never revoke or downgrade anything by themselves.</p> : null}
      {flags && flags.length > 0 ? (
        <ul className="grid gap-3">
          {flags.map((f, i) => (
            <li key={`${f.did}-${f.kind}-${i}`} className="rounded-2xl px-4 py-3" style={{ border: '1px solid color-mix(in srgb, var(--bp-fg) 12%, transparent)' }}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <code className="break-all text-sm">{f.did}</code>
                <span className="text-xs uppercase muted">{f.kind}</span>
              </div>
              <p className="mt-1 text-sm">{f.detail}</p>
              <p className="mt-1 text-xs muted">
                Since <LocalTime iso={f.since} />
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

function MembersTab() {
  const [members, setMembers] = useState<StewardMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await stewardFetch<{ members: StewardMember[] }>('/api/vta/steward/members');
      setMembers(data.members);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="grid gap-5">
      {error ? <Notice kind="error">{error}</Notice> : null}
      {members === null ? <p className="text-sm muted">Loading…</p> : null}
      {members && members.length === 0 ? <p>No members yet.</p> : null}
      {members && members.length > 0 ? (
        <ul className="grid gap-3">
          {members.map((m) => (
            <li key={m.did} className="rounded-2xl px-4 py-3" style={{ border: '1px solid color-mix(in srgb, var(--bp-fg) 12%, transparent)' }}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <code className="break-all text-sm">{m.did}</code>
                <div className="flex items-center gap-2">
                  <TierBadge tier={/^T[0-4]$/.test(m.governanceTier) ? (m.governanceTier as Tier) : 'T0'} />
                  <span className="text-xs muted">{m.status}</span>
                </div>
              </div>
              <p className="mt-1 text-xs muted">
                {m.expired ? 'Expired' : 'Valid'}
                {m.joinedAt ? (
                  <>
                    {' '}
                    · joined <LocalTime iso={m.joinedAt} />
                  </>
                ) : null}
              </p>
              {['T3', 'T4'].includes(m.governanceTier) ? (
                <p className="mt-2 text-xs muted">Stewards and anchors are protected here; raise or lower them through pod governance.</p>
              ) : editing === m.did ? (
                <SetTierForm
                  did={m.did}
                  onDone={() => {
                    setEditing(null);
                    void load();
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setEditing(m.did)}>
                  Set tier
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SetTierForm({ did, onDone, onCancel }: { did: string; onDone: () => void; onCancel: () => void }) {
  const [tier, setTier] = useState<Tier>('T1');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!reason.trim()) {
      setError('A governance decision needs a reason.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await stewardFetch(`/api/vta/steward/members/${encodeURIComponent(did)}/tier`, { method: 'POST', body: JSON.stringify({ tier, reason: reason.trim() }) });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 grid gap-3 rounded-2xl p-3" style={{ background: 'color-mix(in srgb, var(--bp-fg) 5%, transparent)' }}>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="New tier" htmlFor={`tier-${did}`}>
          <Select id={`tier-${did}`} value={tier} onChange={(e) => setTier(e.target.value as Tier)}>
            {STEWARD_TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reason" htmlFor={`reason-${did}`} className="flex-1">
          <Input id={`reason-${did}`} value={reason} onChange={(e) => setReason(e.target.value)} required />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function EventsTab({ base, canConvene }: { base: string; canConvene: boolean }) {
  const [events, setEvents] = useState<EventView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await stewardFetch<{ events: EventView[] }>(`${base}/events`);
      setEvents(data.events);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="grid gap-5">
      {canConvene ? (
        <div>
          <Button type="button" variant="secondary" size="sm" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Close' : 'Create attestation event'}
          </Button>
          {showForm ? (
            <CreateEventForm
              base={base}
              onCreated={() => {
                setShowForm(false);
                void load();
              }}
            />
          ) : null}
        </div>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {events === null ? <p className="text-sm muted">Loading…</p> : null}
      {events && events.length === 0 ? <p>No events yet.</p> : null}
      {events && events.length > 0 ? (
        <ul className="grid gap-3">
          {events.map((e) => (
            <li key={e.id} className="rounded-2xl px-4 py-3" style={{ border: '1px solid color-mix(in srgb, var(--bp-fg) 12%, transparent)' }}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{e.title}</span>
                {e.attestation ? <span className="text-xs uppercase muted">attestation</span> : null}
              </div>
              <p className="mt-1 text-xs muted">
                {e.startsAt ? <LocalTime iso={e.startsAt} /> : 'To be announced'}
                {e.placeId ? ` · ${e.placeId}` : ''}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CreateEventForm({ base, onCreated }: { base: string; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [placeId, setPlaceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const starts = new Date(startsAt);
    const ends = new Date(endsAt);
    if (!title.trim() || Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) {
      setError('The event needs a title, a start and an end.');
      return;
    }
    setBusy(true);
    try {
      await stewardFetch(`${base}/events`, {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          startsAt: starts.toISOString(),
          endsAt: ends.toISOString(),
          ...(placeId.trim() ? { placeId: placeId.trim() } : {}),
        }),
      });
      setTitle('');
      setStartsAt('');
      setEndsAt('');
      setPlaceId('');
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 grid max-w-md gap-3 rounded-2xl p-4" style={{ background: 'color-mix(in srgb, var(--bp-fg) 5%, transparent)' }}>
      <Field label="Title" htmlFor="ev-title">
        <Input id="ev-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </Field>
      <Field label="Starts" htmlFor="ev-start">
        <Input id="ev-start" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
      </Field>
      <Field label="Ends" htmlFor="ev-end">
        <Input id="ev-end" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required />
      </Field>
      <Field label="Place (optional)" htmlFor="ev-place">
        <Input id="ev-place" value={placeId} onChange={(e) => setPlaceId(e.target.value)} />
      </Field>
      <div>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Creating…' : 'Create event'}
        </Button>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Authority log
// ---------------------------------------------------------------------------

function AuthorityLogTab() {
  const [entries, setEntries] = useState<VacLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await stewardFetch<{ entries: VacLogEntry[] }>('/api/vta/steward/vac-log');
      setEntries(data.entries);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="grid gap-5">
      {error ? <Notice kind="error">{error}</Notice> : null}
      {entries === null ? <p className="text-sm muted">Loading…</p> : null}
      {entries && entries.length === 0 ? <p>No permissions have been issued yet.</p> : null}
      {entries && entries.length > 0 ? (
        <ul className="grid gap-3">
          {entries.map((e) => (
            <li key={e.id} className="rounded-2xl px-4 py-3" style={{ border: '1px solid color-mix(in srgb, var(--bp-fg) 12%, transparent)' }}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <code className="break-all text-sm">{e.subject}</code>
                <TierBadge tier={/^T[0-4]$/.test(e.tier) ? (e.tier as Tier) : 'T0'} />
              </div>
              <p className="mt-1 text-xs muted">
                {e.issuedAt ? (
                  <>
                    Issued <LocalTime iso={e.issuedAt} />
                  </>
                ) : null}
                {e.validUntil ? (
                  <>
                    {' '}
                    · valid until <LocalTime iso={e.validUntil} />
                  </>
                ) : null}
              </p>
              {e.revokedAt ? (
                <p className="mt-2 text-xs" style={{ color: '#b3261e' }}>
                  Revoked <LocalTime iso={e.revokedAt} />
                </p>
              ) : revoking === e.id ? (
                <RevokeForm
                  entry={e}
                  onDone={() => {
                    setRevoking(null);
                    void load();
                  }}
                  onCancel={() => setRevoking(null)}
                />
              ) : e.credential ? (
                <Button type="button" variant="danger" size="sm" className="mt-2" onClick={() => setRevoking(e.id)}>
                  Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RevokeForm({ entry, onDone, onCancel }: { entry: VacLogEntry; onDone: () => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!reason.trim()) {
      setError('Revoking needs a reason.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const digest = digestMultibase(entry.credential);
      await stewardFetch('/api/vta/authority/revoke', { method: 'POST', body: JSON.stringify({ digest, reason: reason.trim() }) });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 grid gap-3 rounded-2xl p-3" style={{ background: 'color-mix(in srgb, var(--bp-fg) 5%, transparent)' }}>
      <Field label="Reason" htmlFor={`revoke-reason-${entry.id}`}>
        <Input id={`revoke-reason-${entry.id}`} value={reason} onChange={(e) => setReason(e.target.value)} required />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" variant="danger" size="sm" disabled={busy}>
          {busy ? 'Revoking…' : 'Confirm revoke'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

function DisputesTab() {
  const [disputes, setDisputes] = useState<Dispute[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adjudicating, setAdjudicating] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await stewardFetch<{ disputes: Dispute[] }>('/api/vta/steward/disputes');
      setDisputes(data.disputes);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="grid gap-5">
      {error ? <Notice kind="error">{error}</Notice> : null}
      {disputes === null ? <p className="text-sm muted">Loading…</p> : null}
      {disputes && disputes.length === 0 ? <p>No disputes have been filed.</p> : null}
      {disputes && disputes.length > 0 ? (
        <ul className="grid gap-3">
          {disputes.map((d) => (
            <li key={d.id} className="rounded-2xl px-4 py-3" style={{ border: '1px solid color-mix(in srgb, var(--bp-fg) 12%, transparent)' }}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{d.id}</span>
                <span className="text-xs uppercase muted">{d.status}</span>
              </div>
              <p className="mt-1 text-sm">{d.reason}</p>
              {d.filedBy ? (
                <p className="mt-1 text-xs muted">
                  Filed by <code className="break-all">{d.filedBy}</code>
                  {d.createdAt ? (
                    <>
                      {' '}
                      on <LocalTime iso={d.createdAt} />
                    </>
                  ) : null}
                </p>
              ) : null}
              {d.status !== 'open' ? (
                <p className="mt-2 text-xs muted">Already adjudicated.</p>
              ) : adjudicating === d.id ? (
                <AdjudicateForm
                  id={d.id}
                  onDone={() => {
                    setAdjudicating(null);
                    void load();
                  }}
                  onCancel={() => setAdjudicating(null)}
                />
              ) : (
                <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => setAdjudicating(d.id)}>
                  Adjudicate
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AdjudicateForm({ id, onDone, onCancel }: { id: string; onDone: () => void; onCancel: () => void }) {
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!outcome.trim()) {
      setError('An adjudication needs an outcome.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await stewardFetch(`/api/vta/steward/disputes/${encodeURIComponent(id)}/adjudicate`, { method: 'POST', body: JSON.stringify({ outcome: outcome.trim() }) });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 grid gap-3 rounded-2xl p-3" style={{ background: 'color-mix(in srgb, var(--bp-fg) 5%, transparent)' }}>
      <Field label="Outcome" htmlFor={`outcome-${id}`}>
        <Textarea id={`outcome-${id}`} rows={3} value={outcome} onChange={(e) => setOutcome(e.target.value)} required />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Adjudicate'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Governance log
// ---------------------------------------------------------------------------

function GovernanceLogTab() {
  const [entries, setEntries] = useState<GovernanceLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await stewardFetch<{ entries: GovernanceLogEntry[] }>('/api/vta/steward/governance-log');
        setEntries(data.entries);
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, []);

  return (
    <div className="grid gap-5">
      {error ? <Notice kind="error">{error}</Notice> : null}
      {entries === null ? <p className="text-sm muted">Loading…</p> : null}
      {entries && entries.length === 0 ? <p>No governance decisions have been logged yet.</p> : null}
      {entries && entries.length > 0 ? (
        <ul className="grid gap-3">
          {entries.map((e) => (
            <li key={e.id} className="rounded-2xl px-4 py-3" style={{ border: '1px solid color-mix(in srgb, var(--bp-fg) 12%, transparent)' }}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <code className="break-all text-sm">{e.subject}</code>
                <span className="text-sm">
                  {e.previousTier ?? '—'} → {e.newTier}
                </span>
              </div>
              <p className="mt-1 text-sm">{e.reason}</p>
              <p className="mt-1 text-xs muted">
                By <code className="break-all">{e.by}</code>
                {e.createdAt ? (
                  <>
                    {' '}
                    on <LocalTime iso={e.createdAt} />
                  </>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
