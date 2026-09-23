'use client';

import { useEffect, useState } from 'react';
import { Button, Card, EmptyState, Explain, PageHeader } from '@passport/ui-kit';
import { fetchPodManifest, listRegistryPods } from '@passport/pod-client';
import type { BioregionManifest } from '@passport/tenant-config';
import { useWalletState } from '../_lib/WalletContext';
import { ErrorNotice, useAction } from '../_lib/ui';
import { JoinPod } from './JoinPod';
import { RecoveryKit } from './RecoveryKit';
import { Restore } from './Restore';

type Step = 'create' | 'recovery' | 'choose';
const RECOVERY_SEEN = 'onboarding.recoverySeen';

/** F1 onboarding: create the passport → recovery kit → choose a pod → join as a visitor. */
export function Onboarding({ initialPod }: { initialPod?: string | undefined }) {
  const w = useWalletState();
  const [step, setStep] = useState<Step | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [chosen, setChosen] = useState<string | undefined>(initialPod);

  useEffect(() => {
    if (!w.wallet) return;
    let live = true;
    (async () => {
      if (!(await w.wallet!.exists())) return live && setStep('create');
      const seen = await w.wallet!.setting<boolean>(RECOVERY_SEEN);
      if (live) setStep(seen ? 'choose' : 'recovery');
    })();
    return () => {
      live = false;
    };
  }, [w.wallet, w.version]);

  const create = useAction(async () => {
    await w.wallet!.init();
    setStep('recovery');
    await w.reload();
  });

  if (!step) return null;

  return (
    <div className="grid gap-8">
      <ol className="flex flex-wrap gap-2 text-xs" aria-label="Steps">
        {(['create', 'recovery', 'choose'] as Step[]).map((s, i) => (
          <li
            key={s}
            aria-current={s === step ? 'step' : undefined}
            className="rounded-full px-3 py-1"
            style={{ background: s === step ? 'color-mix(in srgb, var(--bp-primary) 18%, transparent)' : 'color-mix(in srgb, var(--bp-fg) 6%, transparent)' }}
          >
            {i + 1}. {s === 'create' ? 'Create' : s === 'recovery' ? 'Keep it safe' : 'Choose a pod'}
          </li>
        ))}
      </ol>

      {step === 'create' ? (
        restoring ? (
          <div className="grid gap-4">
            <PageHeader title="Restore your passport" subtitle="Bring back a passport you made on another device." />
            <Restore />
            <div>
              <Button variant="ghost" onClick={() => setRestoring(false)}>
                Back
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-6">
            <PageHeader title="Create your passport" subtitle="A passport for the place you live, held on your own phone." />
            <Card className="grid gap-3 text-sm leading-relaxed">
              <p>Your passport holds the credentials your neighbors and your bioregion give you: that you met in person, that someone vouches for you, that you are a member.</p>
              <p>You hold them. No one keeps a central list of who trusts whom, and nothing is shared unless you present it.</p>
            </Card>
            <ErrorNotice error={create.error} />
            <div className="flex flex-wrap gap-3">
              <Button size="lg" onClick={() => void create.run()} disabled={create.busy}>
                {create.busy ? 'Creating…' : 'Create your passport'}
              </Button>
              <Button variant="ghost" onClick={() => setRestoring(true)}>
                I already have one
              </Button>
            </div>
          </div>
        )
      ) : null}

      {step === 'recovery' ? (
        <div className="grid gap-6">
          <PageHeader title="Keep it safe" subtitle="If you lose this phone, this is how you get your passport back." />
          <RecoveryKit
            onDone={async () => {
              await w.wallet!.setSetting(RECOVERY_SEEN, true);
              setStep('choose');
            }}
          />
        </div>
      ) : null}

      {step === 'choose' ? (
        chosen ? (
          <div className="grid gap-4">
            <JoinPod slug={chosen} />
            <div>
              <Button variant="ghost" onClick={() => setChosen(undefined)}>
                Choose a different pod
              </Button>
            </div>
          </div>
        ) : (
          <ChoosePod onChoose={setChosen} />
        )
      ) : null}
    </div>
  );
}

/** Pods on this platform, from the registry. */
export function ChoosePod({ onChoose, exclude = [] }: { onChoose: (slug: string) => void; exclude?: string[] }) {
  const [pods, setPods] = useState<BioregionManifest[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const list = await listRegistryPods();
        const manifests = await Promise.all(list.map((p) => fetchPodManifest(p.slug).catch(() => null)));
        if (live) setPods(manifests.filter((m): m is BioregionManifest => !!m));
      } catch (e) {
        if (live) setError(e);
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  const shown = (pods ?? []).filter((m) => !exclude.includes(m.identity.slug));
  return (
    <div className="grid gap-5">
      <PageHeader title="Choose your pod" subtitle="A pod is a bioregion's own commons: its members, rules, grants and local credit." />
      <ErrorNotice error={error} />
      {pods === null && !error ? <p role="status" className="muted">Finding pods…</p> : null}
      {pods !== null && shown.length === 0 ? <EmptyState title="No other pods yet" body="When a new bioregion opens a pod, it will appear here." /> : null}
      <ul className="grid gap-4">
        {shown.map((m) => (
          <li key={m.identity.slug}>
            <Card className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">{m.identity.name}</h3>
                <p className="text-sm muted">{m.identity.handleDomain}</p>
              </div>
              <Button onClick={() => onChoose(m.identity.slug)}>Choose</Button>
            </Card>
          </li>
        ))}
      </ul>
      <Explain>You can join more pods later; each one gets its own identifier unless you choose otherwise.</Explain>
    </div>
  );
}
