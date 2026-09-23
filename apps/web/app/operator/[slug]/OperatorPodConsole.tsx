'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { BioregionManifest } from '@passport/tenant-config';
import { Button, Field, Input, Notice, Pill, Stat, Textarea } from '@passport/ui-kit';
import { parseManifestJson } from '../manifestValidation';
import { errorMessage, operatorFetch, type ApiError, isApiError } from '../api';
import type { HealthDetailResponse, VerifyReport } from '../types';
import { useOperatorToken } from '../useOperatorToken';
import { BootstrapStewardPanel } from './BootstrapStewardPanel';

type Tab = 'manifest' | 'anchors' | 'governance' | 'trustPolicy' | 'modules' | 'steward' | 'health' | 'verify' | 'export';

const TABS: { key: Tab; label: string }[] = [
  { key: 'manifest', label: 'Manifest' },
  { key: 'anchors', label: 'Anchors' },
  { key: 'governance', label: 'Governance' },
  { key: 'trustPolicy', label: 'Trust policy' },
  { key: 'modules', label: 'Modules' },
  { key: 'steward', label: 'First steward' },
  { key: 'health', label: 'Health' },
  { key: 'verify', label: 'Verify' },
  { key: 'export', label: 'Export' },
];

const TIER_ORDER = ['T0', 'T1', 'T2', 'T3', 'T4'];

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav className="flex flex-wrap gap-1" aria-label="Pod console sections">
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

export function OperatorPodConsole({ slug }: { slug: string }) {
  const { token, setToken, hydrated } = useOperatorToken();
  const [draftKey, setDraftKey] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  const [detail, setDetail] = useState<HealthDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [tab, setTab] = useState<Tab>('manifest');
  const [manifestText, setManifestText] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [downgradeRefusal, setDowngradeRefusal] = useState<string | null>(null);

  const [verifying, setVerifying] = useState(false);
  const [verifyReport, setVerifyReport] = useState<VerifyReport | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [anchorInput, setAnchorInput] = useState('');

  const load = useCallback(
    async (key: string) => {
      setLoading(true);
      setLoadError(null);
      try {
        const data = await operatorFetch<HealthDetailResponse>(`/api/control/health?slug=${encodeURIComponent(slug)}`, key);
        setDetail(data);
        setManifestText(JSON.stringify(data.pod.manifest, null, 2));
        setToken(key);
      } catch (err) {
        setLoadError(errorMessage(err));
        setToken(null);
      } finally {
        setLoading(false);
        setUnlocking(false);
      }
    },
    [slug, setToken],
  );

  useEffect(() => {
    if (hydrated && token) void load(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  function onUnlock(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!draftKey.trim()) return;
    setUnlocking(true);
    setUnlockError(null);
    void load(draftKey.trim());
  }

  const parsed = useMemo(() => parseManifestJson(manifestText), [manifestText]);

  function applyManifest(next: BioregionManifest) {
    setManifestText(JSON.stringify(next, null, 2));
    setSaveNotice(null);
    setDowngradeRefusal(null);
  }

  async function save(allowDowngrade: boolean) {
    if (!token || !parsed.ok) return;
    setSaving(true);
    setSaveNotice(null);
    setDowngradeRefusal(null);
    try {
      const qs = allowDowngrade ? '?allowDowngrade=true' : '';
      await operatorFetch(`/api/control/pods/${encodeURIComponent(slug)}/manifest${qs}`, token, {
        method: 'PUT',
        body: JSON.stringify(parsed.manifest),
      });
      setSaveNotice({ kind: 'success', text: 'Saved and re-signed.' });
      await load(token);
    } catch (err) {
      const apiErr: ApiError | null = isApiError(err) ? err : null;
      if (apiErr?.code === 'DOWNGRADE_REFUSED') {
        setDowngradeRefusal(apiErr.hint ? `${apiErr.message} ${apiErr.hint}` : apiErr.message);
      } else {
        setSaveNotice({ kind: 'error', text: errorMessage(err) });
      }
    } finally {
      setSaving(false);
    }
  }

  async function runVerify() {
    if (!token) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const report = await operatorFetch<VerifyReport>(`/api/control/pods/${encodeURIComponent(slug)}/verify`, token, { method: 'POST' });
      setVerifyReport(report);
    } catch (err) {
      setVerifyError(errorMessage(err));
    } finally {
      setVerifying(false);
    }
  }

  async function runExport() {
    if (!token) return;
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(`/api/control/pods/${encodeURIComponent(slug)}/export`, {
        credentials: 'include',
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw { code: body.code ?? 'ERROR', message: body.message ?? `The export failed (${res.status}).`, hint: body.hint };
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug}-export.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  if (!hydrated) return null;

  if (!token || !detail) {
    return (
      <section aria-labelledby="unlock" className="grid max-w-md gap-5">
        <h2 id="unlock" className="text-2xl font-medium">
          Operator key
        </h2>
        <p className="muted">Present the operator key to open this pod&apos;s console. It stays in this tab only.</p>
        <form onSubmit={onUnlock} className="grid gap-4">
          <Field label="Operator key" htmlFor="opk-key">
            <Input id="opk-key" type="password" autoComplete="off" value={draftKey} onChange={(e) => setDraftKey(e.target.value)} required />
          </Field>
          <div>
            <Button type="submit" disabled={unlocking}>
              {unlocking ? 'Checking…' : 'Unlock console'}
            </Button>
          </div>
        </form>
        {(unlockError || loadError) ? <Notice kind="error">{unlockError ?? loadError}</Notice> : null}
      </section>
    );
  }

  const pod = detail.pod;
  const dirty = manifestText.trim() !== JSON.stringify(pod.manifest, null, 2).trim();

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Pill tone="accent">{pod.status}</Pill>
        <code className="break-all text-xs muted">{pod.did}</code>
        <Button type="button" variant="ghost" size="sm" onClick={() => void load(token)} disabled={loading}>
          Refresh
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setToken(null)}>
          Lock
        </Button>
      </div>

      <TabBar active={tab} onChange={setTab} />

      {tab === 'manifest' ? (
        <ManifestTab
          manifestText={manifestText}
          setManifestText={(t) => {
            setManifestText(t);
            setSaveNotice(null);
            setDowngradeRefusal(null);
          }}
          parsed={parsed}
          saving={saving}
          dirty={dirty}
          saveNotice={saveNotice}
          downgradeRefusal={downgradeRefusal}
          onSave={() => void save(false)}
          onSaveAllowDowngrade={() => void save(true)}
        />
      ) : null}

      {tab === 'anchors' ? (
        <AnchorsTab
          anchors={parsed.ok ? parsed.manifest.governance.anchors : pod.manifest.governance.anchors}
          input={anchorInput}
          setInput={setAnchorInput}
          onAdd={(did) => {
            if (!parsed.ok) return;
            if (parsed.manifest.governance.anchors.includes(did)) return;
            applyManifest({ ...parsed.manifest, governance: { ...parsed.manifest.governance, anchors: [...parsed.manifest.governance.anchors, did] } });
            setAnchorInput('');
          }}
          onRemove={(did) => {
            if (!parsed.ok) return;
            applyManifest({ ...parsed.manifest, governance: { ...parsed.manifest.governance, anchors: parsed.manifest.governance.anchors.filter((a) => a !== did) } });
          }}
          disabled={!parsed.ok}
          dirty={dirty}
          saving={saving}
          saveNotice={saveNotice}
          downgradeRefusal={downgradeRefusal}
          onSave={() => void save(false)}
          onSaveAllowDowngrade={() => void save(true)}
        />
      ) : null}

      {tab === 'governance' ? (
        <GovernanceTab
          manifest={parsed.ok ? parsed.manifest : pod.manifest}
          disabled={!parsed.ok}
          onChange={(gov) => {
            if (!parsed.ok) return;
            applyManifest({ ...parsed.manifest, governance: gov });
          }}
          dirty={dirty}
          saving={saving}
          saveNotice={saveNotice}
          onSave={() => void save(false)}
        />
      ) : null}

      {tab === 'trustPolicy' ? <TrustPolicyTab policy={pod.policy} /> : null}

      {tab === 'modules' ? (
        <ModulesTab
          manifest={parsed.ok ? parsed.manifest : pod.manifest}
          disabled={!parsed.ok}
          onChange={(modules) => {
            if (!parsed.ok) return;
            applyManifest({ ...parsed.manifest, modules });
          }}
          dirty={dirty}
          saving={saving}
          saveNotice={saveNotice}
          onSave={() => void save(false)}
        />
      ) : null}

      {tab === 'steward' ? <BootstrapStewardPanel slug={slug} token={token} /> : null}

      {tab === 'health' ? <HealthTab detail={detail} /> : null}

      {tab === 'verify' ? <VerifyTab busy={verifying} report={verifyReport} error={verifyError} onRun={() => void runVerify()} /> : null}

      {tab === 'export' ? <ExportTab busy={exporting} error={exportError} onRun={() => void runExport()} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SaveBar({
  dirty,
  saving,
  saveNotice,
  downgradeRefusal,
  onSave,
  onSaveAllowDowngrade,
}: {
  dirty: boolean;
  saving: boolean;
  saveNotice: { kind: 'success' | 'error'; text: string } | null;
  downgradeRefusal?: string | null;
  onSave: () => void;
  onSaveAllowDowngrade?: () => void;
}) {
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3">
        <Button type="button" onClick={onSave} disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save & re-sign'}
        </Button>
        {!dirty ? <span className="text-xs muted">No changes to save.</span> : null}
      </div>
      {downgradeRefusal ? (
        <Notice kind="warning">
          <p>{downgradeRefusal}</p>
          {onSaveAllowDowngrade ? (
            <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={onSaveAllowDowngrade} disabled={saving}>
              Save anyway (allow downgrade)
            </Button>
          ) : null}
        </Notice>
      ) : null}
      {saveNotice ? <Notice kind={saveNotice.kind}>{saveNotice.text}</Notice> : null}
    </div>
  );
}

function ThemeSwatch({ manifest }: { manifest: BioregionManifest }) {
  const t = manifest.theme.tokens;
  return (
    <div className="flex items-center gap-2">
      {(['primary', 'accent', 'bg', 'fg'] as const).map((key) => (
        <div key={key} className="grid gap-1 text-center">
          <span aria-hidden="true" className="block h-8 w-8 rounded-full border" style={{ background: t[key], borderColor: 'color-mix(in srgb, var(--bp-fg) 20%, transparent)' }} />
          <span className="text-[10px] uppercase muted">{key}</span>
        </div>
      ))}
    </div>
  );
}

function ManifestTab({
  manifestText,
  setManifestText,
  parsed,
  saving,
  dirty,
  saveNotice,
  downgradeRefusal,
  onSave,
  onSaveAllowDowngrade,
}: {
  manifestText: string;
  setManifestText: (t: string) => void;
  parsed: ReturnType<typeof parseManifestJson>;
  saving: boolean;
  dirty: boolean;
  saveNotice: { kind: 'success' | 'error'; text: string } | null;
  downgradeRefusal: string | null;
  onSave: () => void;
  onSaveAllowDowngrade: () => void;
}) {
  return (
    <div className="grid gap-5">
      {parsed.ok ? <ThemeSwatch manifest={parsed.manifest} /> : null}
      <Field label="Manifest (JSON)" htmlFor="manifest-json" error={parsed.ok ? undefined : parsed.errors.join(' ')}>
        <Textarea id="manifest-json" value={manifestText} onChange={(e) => setManifestText(e.target.value)} rows={22} spellCheck={false} className="font-mono text-xs" />
      </Field>
      <SaveBar dirty={dirty} saving={saving} saveNotice={saveNotice} downgradeRefusal={downgradeRefusal} onSave={onSave} onSaveAllowDowngrade={onSaveAllowDowngrade} />
    </div>
  );
}

function AnchorsTab({
  anchors,
  input,
  setInput,
  onAdd,
  onRemove,
  disabled,
  dirty,
  saving,
  saveNotice,
  downgradeRefusal,
  onSave,
  onSaveAllowDowngrade,
}: {
  anchors: string[];
  input: string;
  setInput: (v: string) => void;
  onAdd: (did: string) => void;
  onRemove: (did: string) => void;
  disabled: boolean;
  dirty: boolean;
  saving: boolean;
  saveNotice: { kind: 'success' | 'error'; text: string } | null;
  downgradeRefusal: string | null;
  onSave: () => void;
  onSaveAllowDowngrade: () => void;
}) {
  return (
    <div className="grid gap-5">
      <p className="max-w-2xl text-sm muted">
        Anchors are the DIDs the registry recognises as this pod&apos;s named governance. Removing an anchor is a downgrade: saving it needs an explicit confirmation.
      </p>
      {anchors.length === 0 ? (
        <p>No anchors are named yet.</p>
      ) : (
        <ul className="grid gap-2">
          {anchors.map((a) => (
            <li key={a} className="flex items-center justify-between gap-3 rounded-2xl px-4 py-2 text-sm" style={{ border: '1px solid color-mix(in srgb, var(--bp-fg) 12%, transparent)' }}>
              <code className="break-all">{a}</code>
              <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onRemove(a)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim()) onAdd(input.trim());
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <Field label="Add anchor DID" htmlFor="anchor-did" className="flex-1">
          <Input id="anchor-did" value={input} onChange={(e) => setInput(e.target.value)} placeholder="did:web:example.org:dids:anchor" disabled={disabled} />
        </Field>
        <Button type="submit" variant="secondary" disabled={disabled || !input.trim()}>
          Add
        </Button>
      </form>
      <SaveBar dirty={dirty} saving={saving} saveNotice={saveNotice} downgradeRefusal={downgradeRefusal} onSave={onSave} onSaveAllowDowngrade={onSaveAllowDowngrade} />
    </div>
  );
}

function GovernanceTab({
  manifest,
  disabled,
  onChange,
  dirty,
  saving,
  saveNotice,
  onSave,
}: {
  manifest: BioregionManifest;
  disabled: boolean;
  onChange: (gov: BioregionManifest['governance']) => void;
  dirty: boolean;
  saving: boolean;
  saveNotice: { kind: 'success' | 'error'; text: string } | null;
  onSave: () => void;
}) {
  const gov = manifest.governance;
  return (
    <div className="grid gap-5">
      <Field label="Governance document URL" htmlFor="gov-url">
        <Input id="gov-url" value={gov.url} disabled={disabled} onChange={(e) => onChange({ ...gov, url: e.target.value })} />
      </Field>
      <Field label="Disclosure sentence" htmlFor="gov-disclosure">
        <Textarea id="gov-disclosure" rows={3} value={gov.disclosure} disabled={disabled} onChange={(e) => onChange({ ...gov, disclosure: e.target.value })} />
      </Field>
      <Field label="Disputes contact" htmlFor="gov-disputes">
        <Input id="gov-disputes" value={gov.disputes} disabled={disabled} onChange={(e) => onChange({ ...gov, disputes: e.target.value })} />
      </Field>
      <SaveBar dirty={dirty} saving={saving} saveNotice={saveNotice} onSave={onSave} />
    </div>
  );
}

function TrustPolicyTab({ policy }: { policy: HealthDetailResponse['pod']['policy'] }) {
  return (
    <div className="grid gap-5">
      <Notice kind="info">This pod&apos;s trust policy is signed at provisioning time. Policy updates ship in the next release — this view is read-only.</Notice>
      {policy ? (
        <pre className="max-h-[32rem] overflow-auto rounded-2xl p-4 text-xs" style={{ border: '1px solid color-mix(in srgb, var(--bp-fg) 12%, transparent)' }}>
          {JSON.stringify(policy, null, 2)}
        </pre>
      ) : (
        <p>No signed trust policy has been recorded for this pod yet.</p>
      )}
    </div>
  );
}

function ModulesTab({
  manifest,
  disabled,
  onChange,
  dirty,
  saving,
  saveNotice,
  onSave,
}: {
  manifest: BioregionManifest;
  disabled: boolean;
  onChange: (modules: BioregionManifest['modules']) => void;
  dirty: boolean;
  saving: boolean;
  saveNotice: { kind: 'success' | 'error'; text: string } | null;
  onSave: () => void;
}) {
  const m = manifest.modules;
  const TOGGLES: { key: 'map' | 'grants' | 'circulation' | 'merchant'; label: string }[] = [
    { key: 'map', label: 'Map' },
    { key: 'grants', label: 'Grants' },
    { key: 'circulation', label: 'Local credit (circulation)' },
    { key: 'merchant', label: 'Merchant' },
  ];
  return (
    <div className="grid gap-5">
      <ul className="grid gap-3 sm:grid-cols-2">
        {TOGGLES.map((t) => (
          <li key={t.key} className="flex items-center gap-3 rounded-2xl px-4 py-3" style={{ border: '1px solid color-mix(in srgb, var(--bp-fg) 12%, transparent)' }}>
            <input
              id={`module-${t.key}`}
              type="checkbox"
              checked={m[t.key]}
              disabled={disabled}
              onChange={(e) => onChange({ ...m, [t.key]: e.target.checked })}
            />
            <label htmlFor={`module-${t.key}`} className="text-sm font-medium">
              {t.label}
            </label>
          </li>
        ))}
      </ul>
      <div>
        <h3 className="text-lg font-medium">Third-party modules</h3>
        {m.thirdParty.length === 0 ? (
          <p className="mt-2 text-sm muted">None registered. Edit the raw manifest to add one.</p>
        ) : (
          <ul className="mt-2 grid gap-2">
            {m.thirdParty.map((app) => (
              <li key={app.id} className="rounded-2xl px-4 py-2 text-sm" style={{ border: '1px solid color-mix(in srgb, var(--bp-fg) 12%, transparent)' }}>
                <strong>{app.name}</strong> — <code className="text-xs">{app.deepLink}</code>
                {app.requires.length > 0 ? <span className="ml-2 muted">requires {app.requires.join(', ')}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <SaveBar dirty={dirty} saving={saving} saveNotice={saveNotice} onSave={onSave} />
    </div>
  );
}

function HealthTab({ detail }: { detail: HealthDetailResponse }) {
  const pod = detail.pod;
  return (
    <div className="grid gap-8">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Members" value={pod.membersTotal} />
        <Stat label="Events" value={pod.events} />
        {TIER_ORDER.filter((t) => pod.members[t]).map((t) => (
          <Stat key={t} label={`At ${t}`} value={pod.members[t] ?? 0} />
        ))}
      </div>
      <div>
        <h3 className="text-lg font-medium">Migrations</h3>
        {pod.pendingMigrations.length === 0 ? (
          <p className="mt-1 text-sm muted">This pod&apos;s schema is fully migrated.</p>
        ) : (
          <p className="mt-1 text-sm">Pending: {pod.pendingMigrations.join(', ')}</p>
        )}
        {detail.platform.pendingMigrations.length > 0 ? (
          <p className="mt-1 text-sm">Platform schema pending: {detail.platform.pendingMigrations.join(', ')}</p>
        ) : (
          <p className="mt-1 text-sm muted">Platform schema is fully migrated ({detail.platform.platformMigrationFiles} files).</p>
        )}
      </div>
      <div>
        <h3 className="text-lg font-medium">Last tenant-zero run</h3>
        {detail.lastTenantZeroRun ? (
          <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="muted">Result</dt>
            <dd>{detail.lastTenantZeroRun.ok ? 'Passed' : 'Failed'}</dd>
            <dt className="muted">Started</dt>
            <dd>{detail.lastTenantZeroRun.startedAt ?? '—'}</dd>
            <dt className="muted">Finished</dt>
            <dd>{detail.lastTenantZeroRun.finishedAt ?? 'Still running'}</dd>
          </dl>
        ) : (
          <p className="mt-1 text-sm muted">No tenant-zero smoke run has been recorded yet.</p>
        )}
      </div>
    </div>
  );
}

function VerifyTab({ busy, report, error, onRun }: { busy: boolean; report: VerifyReport | null; error: string | null; onRun: () => void }) {
  return (
    <div className="grid gap-5">
      <Button type="button" onClick={onRun} disabled={busy}>
        {busy ? 'Verifying…' : 'Run verify'}
      </Button>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {report ? (
        <div className="grid gap-3">
          <Notice kind={report.ok ? 'success' : 'error'}>
            {report.ok ? 'All checks passed' : 'Some checks failed'} ({report.skipped} skipped).
          </Notice>
          <ul className="grid gap-2">
            {report.checks.map((c) => (
              <li key={c.name} className="flex items-center justify-between gap-3 rounded-2xl px-4 py-2 text-sm" style={{ border: '1px solid color-mix(in srgb, var(--bp-fg) 12%, transparent)' }}>
                <span>{c.name}</span>
                <span>
                  {c.skipped ? 'skipped' : c.ok ? 'ok' : 'failed'}
                  {c.detail ? ` — ${c.detail}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ExportTab({ busy, error, onRun }: { busy: boolean; error: string | null; onRun: () => void }) {
  return (
    <div className="grid gap-5">
      <p className="max-w-2xl text-sm muted">Downloads the pod&apos;s signed manifest, DID document, trust policy and every pod table as one JSON file (for exit or portability).</p>
      <div>
        <Button type="button" onClick={onRun} disabled={busy}>
          {busy ? 'Preparing…' : 'Export pod'}
        </Button>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
    </div>
  );
}
