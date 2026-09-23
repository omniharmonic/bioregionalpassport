'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Field, Notice, Select } from '@passport/ui-kit';
import { ErrorLine, Loading } from '../../circulation/_components/bits';
import { api, gw, type MyEnterprise } from '../../circulation/_lib/api';
import { CommitmentTab } from './CommitmentTab';
import { ExposureTab } from './ExposureTab';
import { ReceiptsTab, type RungUp } from './ReceiptsTab';
import { RegisterForm } from './RegisterForm';
import { RingUp } from './RingUp';
import { RulesTab } from './RulesTab';
import { StaffTab } from './StaffTab';

export interface MerchantProps {
  slug: string;
  base: string;
  unit: string;
  subject: string;
  receiveScopes: string[];
  defaultAcceptance: Record<string, number>;
}

type Tab = 'ring' | 'rules' | 'staff' | 'exposure' | 'commitment' | 'receipts';
const TABS: { key: Tab; label: string; ownerOnly?: boolean }[] = [
  { key: 'ring', label: 'Ring up' },
  { key: 'rules', label: 'Rules', ownerOnly: true },
  { key: 'staff', label: 'Staff', ownerOnly: true },
  { key: 'exposure', label: 'Exposure' },
  { key: 'commitment', label: 'Commitment', ownerOnly: true },
  { key: 'receipts', label: 'Receipts' },
];

/** Merchant Mode: register an enterprise, or ring up sales and manage rules, staff, exposure and receipts. */
export function MerchantMode(props: MerchantProps) {
  const { slug, receiveScopes } = props;
  const [mine, setMine] = useState<MyEnterprise[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('ring');
  const [registering, setRegistering] = useState(false);
  const [rungUp, setRungUp] = useState<RungUp[]>([]);

  const load = useCallback(async () => {
    const res = await api<{ enterprises: MyEnterprise[] }>(slug, gw('/merchant/enterprises/mine'));
    if (!res.ok) {
      setError(res.message);
      setMine([]);
      return;
    }
    setError(null);
    setMine(res.data.enterprises);
    setSelected((cur) => (cur && res.data.enterprises.some((e) => e.did === cur) ? cur : (res.data.enterprises[0]?.did ?? null)));
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  if (mine === null) return <Loading />;

  const noAuthority = receiveScopes.length === 0;
  if (registering || (mine.length === 0 && noAuthority)) {
    return (
      <div className="grid gap-4">
        <ErrorLine message={error} />
        <RegisterForm
          {...props}
          onDone={() => {
            setRegistering(false);
            void load();
          }}
          onCancel={mine.length > 0 ? () => setRegistering(false) : undefined}
        />
      </div>
    );
  }
  if (mine.length === 0) {
    return (
      <div className="grid gap-4">
        <ErrorLine message={error} />
        <Notice kind="warning">
          Your passport carries authority to receive payments, but this pod no longer lists you as owner or staff of that enterprise.
        </Notice>
        <div>
          <Button onClick={() => setRegistering(true)}>Register your enterprise</Button>
        </div>
      </div>
    );
  }

  const ent = mine.find((e) => e.did === selected) ?? mine[0]!;
  const isOwner = ent.role === 'owner';
  const canRingUp = receiveScopes.includes(ent.did);
  const tabs = TABS.filter((t) => !t.ownerOnly || isOwner);
  const active = tabs.some((t) => t.key === tab) ? tab : 'ring';

  return (
    <div className="grid gap-8">
      <ErrorLine message={error} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        {mine.length > 1 ? (
          <Field label="Enterprise" htmlFor="enterprise-pick" className="min-w-[16rem]">
            <Select id="enterprise-pick" value={ent.did} onChange={(e) => setSelected(e.target.value)}>
              {mine.map((m) => (
                <option key={m.did} value={m.did}>
                  {m.name} ({m.role})
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <h2 className="text-2xl font-medium">
            {ent.name} <span className="text-base muted">· {ent.role}</span>
          </h2>
        )}
        <Button variant="ghost" size="sm" onClick={() => setRegistering(true)}>
          Register another enterprise
        </Button>
      </div>

      <div role="tablist" aria-label="Merchant Mode" className="flex flex-wrap gap-2 border-b rule pb-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            id={`tab-${t.key}`}
            aria-selected={active === t.key}
            aria-controls={`panel-${t.key}`}
            onClick={() => setTab(t.key)}
            className="rounded-xl px-3 py-1.5 text-sm font-medium"
            style={
              active === t.key
                ? { background: 'var(--bp-primary)', color: '#fff' }
                : { background: 'transparent', color: 'var(--bp-fg)', border: '1px solid color-mix(in srgb, var(--bp-fg) 15%, transparent)' }
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`}>
        {active === 'ring' ? (
          canRingUp ? (
            <RingUp
              key={ent.did}
              slug={slug}
              unit={props.unit}
              enterprise={ent}
              onRungUp={(r) => setRungUp((list) => [r, ...list.filter((x) => x.transactionId !== r.transactionId)])}
              onSettled={() => void load()}
            />
          ) : (
            <Notice kind="info">
              To ring up sales for {ent.name}, save your authority to receive payments there to your passport, then present your
              passport to this pod again.
            </Notice>
          )
        ) : null}
        {active === 'rules' ? <RulesTab key={ent.did} slug={slug} unit={props.unit} enterprise={ent} defaultAcceptance={props.defaultAcceptance} onSaved={load} /> : null}
        {active === 'staff' ? <StaffTab key={ent.did} slug={slug} subject={props.subject} enterprise={ent} onChanged={load} /> : null}
        {active === 'exposure' ? <ExposureTab key={ent.did} slug={slug} unit={props.unit} enterprise={ent} /> : null}
        {active === 'commitment' ? <CommitmentTab key={ent.did} slug={slug} enterprise={ent} onSaved={load} /> : null}
        {active === 'receipts' ? <ReceiptsTab slug={slug} base={props.base} unit={props.unit} rungUp={rungUp.filter((r) => r.enterpriseDid === ent.did)} /> : null}
      </div>
    </div>
  );
}
