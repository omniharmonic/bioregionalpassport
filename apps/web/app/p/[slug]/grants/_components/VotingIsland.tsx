'use client';

import { useEffect, useMemo, useState } from 'react';
import { keyPairFromSeed, type VerifiableCredential } from '@passport/credential-core';
import { Button, Field, Notice, Select } from '@passport/ui-kit';
import { roundApi } from '../_lib/api';
import {
  MAX_VOTES_PER_PROPOSAL,
  ballotBody,
  canAddVote,
  getPersonaSeed,
  getPodCredentials,
  groupsFor,
  meter,
  type Allocations,
  type GroupOption,
} from '../_lib/voting';

export interface VotingIslandProps {
  slug: string;
  roundId: string;
  proposals: { id: string; title: string }[];
  voiceBudget: number;
  /** Pod host, the presentation domain for group votes. */
  domain: string;
  walletHref: string;
  signedIn: boolean;
}

type Passport =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'ready'; seed: Uint8Array; credentials: VerifiableCredential[]; groups: GroupOption[] };

type Outcome = { kind: 'success' | 'error'; text: string } | null;

export function VotingIsland({ slug, roundId, proposals, voiceBudget, domain, walletHref, signedIn }: VotingIslandProps) {
  const [passport, setPassport] = useState<Passport>({ state: 'loading' });
  const [allocations, setAllocations] = useState<Allocations>({});
  const [voteAs, setVoteAs] = useState<string>('self');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const seed = await getPersonaSeed(slug);
      if (!live) return;
      if (!seed) return setPassport({ state: 'none' });
      const credentials = await getPodCredentials(slug);
      if (!live) return;
      setPassport({ state: 'ready', seed, credentials, groups: groupsFor(credentials, keyPairFromSeed(seed).did) });
    })().catch(() => live && setPassport({ state: 'none' }));
    return () => {
      live = false;
    };
  }, [slug]);

  const m = useMemo(() => meter(allocations, voiceBudget), [allocations, voiceBudget]);

  const step = (id: string, delta: 1 | -1) => {
    setOutcome(null);
    setAllocations((a) => {
      const current = a[id] ?? 0;
      if (delta === 1 && !canAddVote(a, id, voiceBudget)) return a;
      const next = Math.max(0, Math.min(MAX_VOTES_PER_PROPOSAL, current + delta));
      return { ...a, [id]: next };
    });
  };

  if (passport.state === 'loading') return <p role="status">Opening your passport…</p>;
  if (passport.state === 'none') {
    return (
      <Notice kind="info">
        <a href={walletHref}>Open your passport to vote</a>. Your ballot is signed on this device with a key made for this round only.
      </Notice>
    );
  }

  const submit = async () => {
    if (passport.state !== 'ready') return;
    setBusy(true);
    setOutcome(null);
    try {
      const group = voteAs === 'self' ? undefined : voteAs;
      const body = ballotBody(passport.seed, roundId, allocations, group ? { group, credentials: passport.credentials, domain } : {});
      const res = await roundApi<{ message: string }>(slug, `/rounds/${encodeURIComponent(roundId)}/ballots`, { method: 'POST', body });
      setOutcome(res.ok ? { kind: 'success', text: 'Ballot recorded (you can change it until the round closes).' } : { kind: 'error', text: res.message });
    } catch (e) {
      setOutcome({ kind: 'error', text: e instanceof Error ? e.message : 'Your ballot could not be prepared.' });
    } finally {
      setBusy(false);
    }
  };

  const empty = m.cost === 0;
  const barColor = m.over ? '#b3261e' : 'var(--bp-primary)';

  return (
    <div className="grid gap-5">
      {!signedIn ? (
        <Notice kind="warning">
          Present your passport to this pod before voting. <a href={walletHref}>Open your passport</a>.
        </Notice>
      ) : null}

      {passport.groups.length > 0 ? (
        <Field label="Vote as" htmlFor="vote-as" hint="A group you steward can cast its own ballot, separate from yours.">
          <Select id="vote-as" value={voteAs} onChange={(e) => setVoteAs(e.target.value)}>
            <option value="self">Myself</option>
            {passport.groups.map((g) => (
              <option key={g.did} value={g.did}>
                {g.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <div className="grid gap-2" aria-live="polite">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span className="font-medium">Voice credits</span>
          <span>
            {m.cost} of {m.budget} spent{m.over ? ' — over budget' : `, ${m.remaining} left`}
          </span>
        </div>
        <div
          role="meter"
          aria-label="Voice credits spent"
          aria-valuemin={0}
          aria-valuemax={m.budget}
          aria-valuenow={m.cost}
          className="h-3 w-full overflow-hidden rounded-full"
          style={{ background: 'color-mix(in srgb, var(--bp-fg) 12%, transparent)' }}
        >
          <div className="h-full rounded-full" style={{ width: `${m.fraction * 100}%`, background: barColor }} />
        </div>
        <p className="text-sm muted">Each extra vote for the same project costs more: n votes cost n × n credits.</p>
      </div>

      <ul className="grid gap-3">
        {proposals.map((p) => {
          const v = allocations[p.id] ?? 0;
          return (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3">
              <span>{p.title}</span>
              <span className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => step(p.id, -1)} disabled={v === 0 || busy} aria-label={`One vote fewer for ${p.title}`}>
                  −
                </Button>
                <span className="w-16 text-center tabular-nums" aria-label={`Votes for ${p.title}`}>
                  {v} {v === 1 ? 'vote' : 'votes'}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => step(p.id, 1)}
                  disabled={busy || !canAddVote(allocations, p.id, voiceBudget)}
                  aria-label={`One more vote for ${p.title}`}
                >
                  +
                </Button>
                <span className="w-20 text-right text-sm muted tabular-nums">{v * v} credits</span>
              </span>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={submit} disabled={busy || empty || m.over}>
          {busy ? 'Signing and sending…' : voteAs === 'self' ? 'Cast my ballot' : 'Cast the group ballot'}
        </Button>
        {empty ? <span className="text-sm muted">Give at least one vote to cast a ballot.</span> : null}
      </div>

      {outcome ? <Notice kind={outcome.kind}>{outcome.text}</Notice> : null}
    </div>
  );
}
