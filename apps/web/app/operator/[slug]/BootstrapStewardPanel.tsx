'use client';

import { useState, type FormEvent } from 'react';
import { Button, Field, Input, Notice } from '@passport/ui-kit';
import { errorMessage, operatorFetch } from '../api';

interface BootstrapResponse {
  member: { did: string; tier: string; name?: string };
  grant: Record<string, unknown>;
  vacs: unknown[];
}

/**
 * "Bootstrap first steward": `POST /api/control/pods/:slug/bootstrap-steward`. Seeds the DID at T3 with
 * steward permissions and returns a pod-signed membership grant the steward pastes into their passport,
 * where they accept it with their own signature.
 */
export function BootstrapStewardPanel({ slug, token }: { slug: string; token: string }) {
  const [did, setDid] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BootstrapResponse | null>(null);
  const [copied, setCopied] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!did.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      const body = { did: did.trim(), ...(name.trim() ? { name: name.trim() } : {}) };
      const res = await operatorFetch<BootstrapResponse>(`/api/control/pods/${encodeURIComponent(slug)}/bootstrap-steward`, token, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setResult(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const grantJson = result ? JSON.stringify(result.grant, null, 2) : '';

  async function copy() {
    try {
      await navigator.clipboard.writeText(grantJson);
      setCopied(true);
    } catch {
      setError('Could not copy automatically; select the text and copy it by hand.');
    }
  }

  return (
    <section aria-labelledby="bootstrap-steward" className="grid gap-5">
      <h2 id="bootstrap-steward" className="text-xl font-medium">
        Bootstrap first steward
      </h2>
      <p className="max-w-2xl text-sm muted">
        A new pod has nobody who can witness members yet. Name its first steward here: they get steward permissions and a membership
        invitation to accept in their passport. Ask them to join this pod as a visitor first, then send you their identifier from the
        passport home (&ldquo;Your identifier here&rdquo; → Copy).
      </p>
      <form onSubmit={onSubmit} className="grid max-w-2xl gap-4">
        <Field label="Steward's identifier in this pod" htmlFor="bs-did" hint="Starts with did:key:">
          <Input id="bs-did" autoComplete="off" spellCheck={false} value={did} onChange={(e) => setDid(e.target.value)} placeholder="did:key:z…" required />
        </Field>
        <Field label="Name (optional)" htmlFor="bs-name" hint="For your own records; it is not written into the credential.">
          <Input id="bs-name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div>
          <Button type="submit" disabled={busy || !did.trim()}>
            {busy ? 'Bootstrapping…' : 'Bootstrap steward'}
          </Button>
        </div>
      </form>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {result ? (
        <div className="grid gap-3">
          <Notice kind="success">
            {result.member.name ? `${result.member.name} is` : 'This identifier is'} now a {result.member.tier} steward, pending their acceptance.
          </Notice>
          <p className="font-medium">Paste this into your passport: Settings → Add a credential</p>
          <textarea
            readOnly
            aria-label="Membership grant"
            value={grantJson}
            rows={14}
            className="w-full rounded-2xl p-3 font-mono text-xs"
            style={{ border: '1px solid color-mix(in srgb, var(--bp-fg) 15%, transparent)', background: 'transparent', color: 'var(--bp-fg)' }}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="flex items-center gap-3">
            <Button type="button" onClick={() => void copy()}>
              Copy
            </Button>
            {copied ? <span className="text-sm muted" role="status">Copied.</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
