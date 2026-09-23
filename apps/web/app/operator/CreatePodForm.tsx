'use client';

import { useState, type FormEvent } from 'react';
import { Button, Field, Notice, Select, Textarea } from '@passport/ui-kit';
import { parseManifestJson } from './manifestValidation';
import { errorMessage, operatorFetch } from './api';
import type { ProvisionResult } from './types';

/** "Create pod" — validates the manifest client-side before ever sending it. */
export function CreatePodForm({ token, templates, onCreated }: { token: string; templates: Record<string, string>; onCreated: () => void }) {
  const names = Object.keys(templates);
  const [choice, setChoice] = useState(names[0] ?? 'custom');
  const [manifest, setManifest] = useState(templates[names[0] ?? ''] ?? '');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[] | null>(null);
  const [result, setResult] = useState<ProvisionResult | { message: string } | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = parseManifestJson(manifest);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      setResult(null);
      return;
    }
    setErrors(null);
    setBusy(true);
    setResult(null);
    try {
      const created = await operatorFetch<ProvisionResult>('/api/control/pods', token, { method: 'POST', body: JSON.stringify(parsed.manifest) });
      setResult(created);
      onCreated();
    } catch (err) {
      setResult({ message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const isError = (r: typeof result): r is { message: string } => r !== null && 'message' in r;

  return (
    <form onSubmit={onSubmit} className="grid gap-5">
      <Field label="Start from" htmlFor="cp-template">
        <Select
          id="cp-template"
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
      <Field label="Manifest (JSON)" htmlFor="cp-manifest" error={errors ? errors.join(' ') : undefined}>
        <Textarea
          id="cp-manifest"
          value={manifest}
          onChange={(e) => {
            setManifest(e.target.value);
            setChoice('custom');
            if (errors) {
              const check = parseManifestJson(e.target.value);
              setErrors(check.ok ? null : check.errors);
            }
          }}
          rows={14}
          spellCheck={false}
          className="font-mono text-xs"
        />
      </Field>
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Provisioning…' : 'Provision or update pod'}
        </Button>
      </div>
      <div aria-live="polite">
        {result && isError(result) ? <Notice kind="error">{result.message}</Notice> : null}
        {result && !isError(result) ? (
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
