'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Field, Input, Notice, Select, Textarea } from '@passport/ui-kit';
import { roundApi } from '../_lib/api';

type Msg = { kind: 'success' | 'error'; text: string } | null;

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const run = async (slug: string, path: string, body: unknown, done: string): Promise<boolean> => {
    setBusy(true);
    setMsg(null);
    const res = await roundApi(slug, path, { method: 'POST', body });
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: 'error', text: res.message });
      return false;
    }
    setMsg({ kind: 'success', text: done });
    router.refresh();
    return true;
  };
  return { busy, msg, run };
}

const TIER_OPTIONS = [
  { v: 'T1', label: 'Member (T1)' },
  { v: 'T2', label: 'Trusted (T2)' },
  { v: 'T3', label: 'Steward (T3)' },
  { v: 'T4', label: 'Anchor (T4)' },
];

export function CreateRoundForm({ slug, unit }: { slug: string; unit: string }) {
  const { busy, msg, run } = useAction();

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const toIso = (k: string) => {
      const d = new Date(text(k));
      return Number.isNaN(d.getTime()) ? text(k) : d.toISOString();
    };
    const eligibility: Record<string, unknown> = {
      proposeTier: text('proposeTier'),
      voteTier: text('voteTier'),
      voiceBudget: Number(text('voiceBudget')),
    };
    if (text('matchingCap')) eligibility['matchingCap'] = Number(text('matchingCap'));
    const body = { title: text('title'), pool: Number(text('pool')), opensAt: toIso('opensAt'), closesAt: toIso('closesAt'), eligibility };
    if (await run(slug, '/rounds', body, 'Round created as a draft. Open it when it is ready.')) form.reset();
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
      <Field label="Title" htmlFor="r-title" className="sm:col-span-2">
        <Input id="r-title" name="title" required maxLength={200} />
      </Field>
      <Field label={`Pool (${unit})`} htmlFor="r-pool">
        <Input id="r-pool" name="pool" type="number" min="0" step="0.01" required />
      </Field>
      <Field label="Voice credits per voter" htmlFor="r-budget">
        <Input id="r-budget" name="voiceBudget" type="number" min="1" step="1" defaultValue={100} required />
      </Field>
      <Field label="Opens" htmlFor="r-opens">
        <Input id="r-opens" name="opensAt" type="datetime-local" required />
      </Field>
      <Field label="Closes" htmlFor="r-closes">
        <Input id="r-closes" name="closesAt" type="datetime-local" required />
      </Field>
      <Field label="Who can propose" htmlFor="r-propose">
        <Select id="r-propose" name="proposeTier" defaultValue="T2">
          {TIER_OPTIONS.map((t) => (
            <option key={t.v} value={t.v}>
              {t.label} and above
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Who can vote" htmlFor="r-vote">
        <Select id="r-vote" name="voteTier" defaultValue="T2">
          {TIER_OPTIONS.map((t) => (
            <option key={t.v} value={t.v}>
              {t.label} and above
            </option>
          ))}
        </Select>
      </Field>
      <Field label={`Most matching one project can receive (${unit}, optional)`} htmlFor="r-cap" className="sm:col-span-2">
        <Input id="r-cap" name="matchingCap" type="number" min="0.01" step="0.01" />
      </Field>
      <div className="grid gap-3 sm:col-span-2">
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create round'}
          </Button>
        </div>
        {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      </div>
    </form>
  );
}

const ACTIONS = {
  open: { label: 'Open for proposals and voting', done: 'The round is open.' },
  close: { label: 'Close voting and count', done: 'Voting is closed and the ballots are counted. Review, then publish.' },
  publish: { label: 'Publish results', done: 'Results are published as open records.' },
} as const;

export function RoundActionButton({ slug, roundId, action }: { slug: string; roundId: string; action: keyof typeof ACTIONS }) {
  const { busy, msg, run } = useAction();
  const a = ACTIONS[action];
  return (
    <div className="grid gap-2">
      <div>
        <Button variant={action === 'publish' ? 'primary' : 'secondary'} disabled={busy} onClick={() => run(slug, `/rounds/${encodeURIComponent(roundId)}/${action}`, undefined, a.done)}>
          {busy ? 'Working…' : a.label}
        </Button>
      </div>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
    </div>
  );
}

export function AdjustmentForm({ slug, roundId, proposals }: { slug: string; roundId: string; proposals: { id: string; title: string }[] }) {
  const { busy, msg, run } = useAction();

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const body = { proposalId: String(f.get('proposalId') ?? ''), delta: Number(f.get('delta')), reason: String(f.get('reason') ?? '').trim() };
    if (await run(slug, `/rounds/${encodeURIComponent(roundId)}/adjustments`, body, 'Adjustment logged; the count was updated.')) form.reset();
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
      <Field label="Proposal" htmlFor={`a-p-${roundId}`}>
        <Select id={`a-p-${roundId}`} name="proposalId" required>
          {proposals.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Change to matching" htmlFor={`a-d-${roundId}`} hint="Negative to reduce, positive to add.">
        <Input id={`a-d-${roundId}`} name="delta" type="number" step="0.01" required />
      </Field>
      <Field label="Reason (published with the results)" htmlFor={`a-r-${roundId}`} className="sm:col-span-2">
        <Textarea id={`a-r-${roundId}`} name="reason" rows={3} minLength={3} maxLength={2000} required />
      </Field>
      <div className="grid gap-3 sm:col-span-2">
        <div>
          <Button type="submit" variant="secondary" disabled={busy || proposals.length === 0}>
            {busy ? 'Logging…' : 'Log adjustment'}
          </Button>
        </div>
        {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      </div>
    </form>
  );
}
