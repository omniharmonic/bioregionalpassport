'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, Field, Input, Notice, Select, Textarea } from '@passport/ui-kit';
import { copyText, downloadText, ErrorLine } from '../../circulation/_components/bits';
import { api, gw } from '../../circulation/_lib/api';
import { formatShare } from '../../circulation/_lib/format';
import { getRootCredentials } from '../../circulation/_lib/walletCreds';
import type { MerchantProps } from './MerchantMode';

const CATEGORY_LABELS: Record<string, string> = {
  services: 'Services (labor, care, repairs)',
  suppliers: 'Suppliers (materials, wholesale)',
  retail: 'Retail (shops, food, goods)',
};

interface Created {
  enterprise: { did: string; name: string };
  vac: Record<string, unknown>;
}

/** "Register your enterprise" (`POST /api/gateway/merchant/enterprises`), then hand the owner their authority. */
export function RegisterForm({ slug, podDid, walletHref, defaultAcceptance, onDone, onCancel }: MerchantProps & { onDone: () => void; onCancel?: (() => void) | undefined }) {
  const [name, setName] = useState('');
  const [categories, setCategories] = useState('');
  const [acceptance, setAcceptance] = useState<string>('retail');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  const [noPassport, setNoPassport] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const latN = lat.trim() ? Number(lat) : undefined;
    const lonN = lon.trim() ? Number(lon) : undefined;
    if ((latN !== undefined && !Number.isFinite(latN)) || (lonN !== undefined && !Number.isFinite(lonN))) {
      return setError('Latitude and longitude must be numbers.');
    }
    setNoPassport(false);
    // The gateway checks `credit:account` against the owner's own pod-issued authority credentials.
    const credentials = await getRootCredentials(podDid);
    if (credentials.length === 0) return setNoPassport(true);
    setBusy(true);
    const res = await api<Created>(slug, gw('/merchant/enterprises'), {
      method: 'POST',
      body: {
        credentials,
        name: name.trim(),
        categories: categories.split(',').map((c) => c.trim()).filter(Boolean),
        acceptanceCategory: acceptance,
        ...(latN !== undefined ? { lat: latN } : {}),
        ...(lonN !== undefined ? { lon: lonN } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      },
    });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setCreated(res.data);
  }

  if (created) {
    const text = JSON.stringify(created.vac, null, 2);
    return (
      <Card>
        <div className="grid gap-5">
          <h2 className="text-2xl font-medium">{created.enterprise.name} is registered</h2>
          <p>
            Below is your authority to receive payments at {created.enterprise.name}, signed by the pod. Save this to your passport,
            then present your passport to this pod again to start ringing up sales. Keep it private: it is how the pod knows you
            speak for this enterprise.
          </p>
          <Notice kind="info">
            Your passport cannot import it from this page yet. Copy it or download it now and keep it somewhere safe, then add it
            to your passport when you next open it.
          </Notice>
          <pre className="max-h-80 overflow-auto rounded-xl p-4 text-xs" style={{ background: 'color-mix(in srgb, var(--bp-fg) 6%, transparent)' }}>
            {text}
          </pre>
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={async () => {
                setCopied(await copyText(text));
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button variant="secondary" onClick={() => downloadText(`${slug}-merchant-authority.json`, text)}>
              Download
            </Button>
            <Button variant="ghost" onClick={onDone}>
              Continue to Merchant Mode
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  const share = defaultAcceptance[acceptance];
  return (
    <Card>
      <form onSubmit={submit} className="grid gap-5">
        <div>
          <h2 className="text-2xl font-medium">Register your enterprise</h2>
          <p className="mt-1 muted">It will be listed in the directory as accepting credits. You can change the rules later.</p>
        </div>
        <Field label="Name" htmlFor="ent-name">
          <Input id="ent-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Categories" hint="Comma-separated, e.g. bakery, cafe." htmlFor="ent-cats">
          <Input id="ent-cats" value={categories} onChange={(e) => setCategories(e.target.value)} required />
        </Field>
        <Field
          label="What kind of acceptance?"
          hint={typeof share === 'number' ? `Default: up to ${formatShare(share)} of a sale in credits.` : undefined}
          htmlFor="ent-acc"
        >
          <Select id="ent-acc" value={acceptance} onChange={(e) => setAcceptance(e.target.value)}>
            {Object.keys(CATEGORY_LABELS).map((k) => (
              <option key={k} value={k}>
                {CATEGORY_LABELS[k]}
                {typeof defaultAcceptance[k] === 'number' ? ` — ${formatShare(defaultAcceptance[k]!)}` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Latitude (optional)" htmlFor="ent-lat">
            <Input id="ent-lat" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />
          </Field>
          <Field label="Longitude (optional)" htmlFor="ent-lon">
            <Input id="ent-lon" inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} />
          </Field>
        </div>
        <Field label="Description (optional)" htmlFor="ent-desc">
          <Textarea id="ent-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <ErrorLine message={error} />
        {noPassport ? (
          <Notice kind="warning">
            Open your passport to join this pod first. <a href={walletHref}>Open your passport</a>
          </Notice>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy || !name.trim() || !categories.trim()}>
            {busy ? 'Registering…' : 'Register'}
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
