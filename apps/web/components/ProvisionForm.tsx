'use client';

import { useState, type FormEvent } from 'react';
import { Button, Field, Notice, Select, Textarea, Input } from '@passport/ui-kit';

interface Step {
  name: string;
  status: string;
  detail?: string;
}

type Result =
  | { kind: 'ok'; slug: string; did: string; steps: Step[] }
  | { kind: 'error'; message: string; hint?: string };

/**
 * Posts a manifest to `/api/control/pods` with the operator key. The key is
 * read from the password field for this one request and never stored.
 */
export function ProvisionForm({ templates }: { templates: Record<string, string> }) {
  const names = Object.keys(templates);
  const [choice, setChoice] = useState(names[0] ?? 'custom');
  const [manifest, setManifest] = useState(templates[names[0] ?? ''] ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const key = (form.elements.namedItem('operatorKey') as HTMLInputElement | null)?.value ?? '';
    let body: unknown;
    try {
      body = JSON.parse(manifest);
    } catch {
      setResult({ kind: 'error', message: 'The manifest is not valid JSON.' });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/control/pods', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({ kind: 'error', message: data.message ?? `The request failed (${res.status}).`, hint: data.hint });
      } else {
        setResult({ kind: 'ok', slug: data.slug, did: data.did, steps: data.steps ?? [] });
      }
    } catch {
      setResult({ kind: 'error', message: 'Could not reach the control plane.' });
    } finally {
      setBusy(false);
      const input = form.elements.namedItem('operatorKey') as HTMLInputElement | null;
      if (input) input.value = '';
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-5">
      <Field label="Start from" htmlFor="pv-template">
        <Select
          id="pv-template"
          value={choice}
          onChange={(e) => {
            const v = e.target.value;
            setChoice(v);
            if (templates[v] !== undefined) setManifest(templates[v]);
          }}
        >
          {names.map((n) => (
            <option key={n} value={n}>
              {n} template
            </option>
          ))}
          <option value="custom">My own manifest</option>
        </Select>
      </Field>
      <Field label="Manifest (JSON)" htmlFor="pv-manifest">
        <Textarea
          id="pv-manifest"
          value={manifest}
          onChange={(e) => {
            setManifest(e.target.value);
            setChoice('custom');
          }}
          rows={14}
          spellCheck={false}
          className="font-mono text-xs"
        />
      </Field>
      <Field label="Operator key" htmlFor="pv-key" hint="Used for this request only; never stored.">
        <Input id="pv-key" name="operatorKey" type="password" autoComplete="off" required />
      </Field>
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Provisioning…' : 'Provision or update pod'}
        </Button>
      </div>
      <div aria-live="polite">
        {result?.kind === 'error' ? (
          <Notice kind="error">
            {result.message}
            {result.hint ? ` ${result.hint}` : ''}
          </Notice>
        ) : null}
        {result?.kind === 'ok' ? (
          <Notice kind="success">
            <p>
              {result.slug} is ready as <code className="break-all">{result.did}</code>.
            </p>
            <ul className="mt-2 grid gap-1 text-sm">
              {result.steps.map((s) => (
                <li key={s.name}>
                  {s.name}: {s.status}
                  {s.detail ? ` (${s.detail})` : ''}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}
      </div>
    </form>
  );
}
