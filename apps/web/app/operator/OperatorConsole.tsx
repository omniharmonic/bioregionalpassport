'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Card, Field, Input, Notice, Stat } from '@passport/ui-kit';
import { errorMessage, operatorFetch } from './api';
import type { HealthListResponse, PodHealthSummary } from './types';
import { CreatePodForm } from './CreatePodForm';
import { useOperatorToken } from './useOperatorToken';

const TIER_ORDER = ['T0', 'T1', 'T2', 'T3', 'T4'];

const abbreviate = (did: string): string => (did.length > 28 ? `${did.slice(0, 14)}…${did.slice(-10)}` : did);

/**
 * Everything pod-carrying happens here, client-side, once the operator has
 * supplied the token — the server component that renders this page never
 * queries the platform database (see `apps/web/app/operator/page.tsx`).
 */
export function OperatorConsole({ templates }: { templates: Record<string, string> }) {
  const { token, setToken, hydrated } = useOperatorToken();
  const [health, setHealth] = useState<HealthListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState('');

  const load = useCallback(async (key: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await operatorFetch<HealthListResponse>('/api/control/health', key);
      setHealth(data);
      setToken(key);
    } catch (err) {
      setError(errorMessage(err));
      setHealth(null);
      setToken(null);
    } finally {
      setLoading(false);
    }
  }, [setToken]);

  // Once the stored token has hydrated from sessionStorage, use it to load immediately.
  useEffect(() => {
    if (hydrated && token) void load(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  function onUnlock(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (draftKey.trim()) void load(draftKey.trim());
  }

  function lock() {
    setToken(null);
    setHealth(null);
    setDraftKey('');
  }

  if (!hydrated) return null;

  if (!token || !health) {
    return (
      <section aria-labelledby="unlock" className="grid max-w-md gap-5">
        <h2 id="unlock" className="text-2xl font-medium">
          Operator key
        </h2>
        <p className="muted">Every pod on this platform stays hidden until you present the operator key. It is kept in this tab only and never stored on our side.</p>
        <form onSubmit={onUnlock} className="grid gap-4">
          <Field label="Operator key" htmlFor="op-key">
            <Input id="op-key" type="password" autoComplete="off" value={draftKey} onChange={(e) => setDraftKey(e.target.value)} required />
          </Field>
          <div>
            <Button type="submit" disabled={loading}>
              {loading ? 'Checking…' : 'Unlock console'}
            </Button>
          </div>
        </form>
        {error ? <Notice kind="error">{error}</Notice> : null}
      </section>
    );
  }

  return (
    <div className="grid gap-14">
      <section aria-labelledby="pods" className="grid gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="pods" className="text-2xl font-medium">
            Pods
          </h2>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => void load(token)} disabled={loading}>
              Refresh
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={lock}>
              Lock
            </Button>
          </div>
        </div>
        {health.platform.pendingMigrations.length > 0 ? (
          <Notice kind="warning">The platform schema has pending migrations: {health.platform.pendingMigrations.join(', ')}.</Notice>
        ) : null}
        {health.pods.length === 0 ? (
          <p>No pods are provisioned yet.</p>
        ) : (
          <ul className="grid gap-5">
            {health.pods.map((pod) => (
              <PodRow key={pod.slug} pod={pod} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="provision" className="grid gap-5">
        <h2 id="provision" className="text-2xl font-medium">
          Create or update a pod
        </h2>
        <p className="max-w-2xl muted">Provisioning is idempotent: sending the same manifest again updates the pod and keeps its identifier and key.</p>
        <CreatePodForm token={token} templates={templates} onCreated={() => void load(token)} />
      </section>
    </div>
  );
}

function PodRow({ pod }: { pod: PodHealthSummary }) {
  return (
    <li>
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xl font-medium">
            <a href={`/operator/${pod.slug}`}>{pod.name}</a>
          </h3>
          <span className="text-sm">Status: {pod.status}</span>
        </div>
        <p className="mt-1 break-all text-xs muted" title={pod.did}>
          {pod.slug} · {abbreviate(pod.did)}
        </p>
        {pod.error ? (
          <p className="mt-4 text-sm">{pod.error}</p>
        ) : (
          <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Members" value={pod.membersTotal} />
            <Stat label="Events" value={pod.events} />
            {TIER_ORDER.filter((t) => pod.members[t]).map((t) => (
              <Stat key={t} label={`At ${t}`} value={pod.members[t] ?? 0} />
            ))}
          </div>
        )}
        {pod.pendingMigrations.length > 0 ? (
          <p className="mt-3 text-xs" style={{ color: '#b8860b' }}>
            Pending migrations: {pod.pendingMigrations.join(', ')}
          </p>
        ) : null}
      </Card>
    </li>
  );
}
