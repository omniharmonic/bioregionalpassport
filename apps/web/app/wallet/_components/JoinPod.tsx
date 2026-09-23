'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Explain, Notice } from '@passport/ui-kit';
import { abbreviateDid, fetchPodManifest, PodClient } from '@passport/pod-client';
import { copy, type BioregionManifest } from '@passport/tenant-config';
import { useWalletState } from '../_lib/WalletContext';
import { ErrorNotice, useAction } from '../_lib/ui';

/**
 * Join a pod (F1): mint a directed persona (or reuse one, FR-ID-6), store the manifest, open a visitor session.
 * Consent is structural: nothing is sent to the pod except a holder-only sign-in.
 */
export function JoinPod({ slug, onJoined }: { slug: string; onJoined?: () => void }) {
  const w = useWalletState();
  const router = useRouter();
  const [manifest, setManifest] = useState<BioregionManifest | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [choice, setChoice] = useState<'new' | string>('new');
  const others = w.pods.filter((p) => p.slug !== slug);
  const already = w.pods.some((p) => p.slug === slug);

  useEffect(() => {
    let live = true;
    fetchPodManifest(slug)
      .then((m) => live && setManifest(m))
      .catch((e) => live && setLoadError(e));
    return () => {
      live = false;
    };
  }, [slug]);

  const join = useAction(async () => {
    if (!w.wallet || !manifest) return;
    if (!(await w.wallet.exists())) await w.wallet.init();
    const persona = await w.wallet.mintPersona(slug, choice === 'new' ? {} : { reuse: choice });
    await w.wallet.addPod(manifest, persona.did);
    await w.wallet.setLastPod(slug);
    const client = new PodClient({ slug, manifest, persona, db: w.wallet.db });
    try {
      await client.visitorSession();
    } catch {
      // Browsing works without a session; sign-in is retried when a gate needs it.
    }
    await w.reload();
    onJoined?.();
    router.push(`/wallet?pod=${encodeURIComponent(slug)}`);
  });

  if (loadError) return <ErrorNotice error={loadError} />;
  if (!manifest) return <p role="status" className="muted">Looking up this pod…</p>;
  if (already) {
    return (
      <Card>
        <p>
          Your passport already belongs to <strong>{manifest.identity.name}</strong>.
        </p>
        <div className="mt-4">
          <Button href={`/wallet?pod=${encodeURIComponent(slug)}`}>Open it</Button>
        </div>
      </Card>
    );
  }
  return (
    <Card className="grid gap-4">
      <div>
        <p className="eyebrow">Join a pod</p>
        <h2 className="mt-1 text-2xl font-semibold">{manifest.identity.name}</h2>
      </div>
      <p>
        You will start as a {copy(manifest, 'tier.T0.name').toLowerCase()}: you can browse the map, directory and events. Membership begins in person, at an
        attestation event.
      </p>
      {others.length > 0 ? (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Which identifier should {manifest.identity.name} see?</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="persona" checked={choice === 'new'} onChange={() => setChoice('new')} />
            <span>
              <strong>A new identifier</strong> (recommended): pods cannot link your activity to each other.
            </span>
          </label>
          {others.map((p) => (
            <label key={p.slug} className="flex items-start gap-2 text-sm">
              <input type="radio" name="persona" checked={choice === p.personaDid} onChange={() => setChoice(p.personaDid)} />
              <span>
                <strong>Reuse my identifier from {p.manifest.identity.name}</strong> ({abbreviateDid(p.personaDid)}): both pods will know it is you.
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <Explain>Your passport makes a key for this pod on this device; the pod only ever sees what you choose to present.</Explain>
      <ErrorNotice error={join.error} />
      <div>
        <Button onClick={() => void join.run()} disabled={join.busy}>
          {join.busy ? 'Joining…' : `Join ${manifest.identity.name}`}
        </Button>
      </div>
      {manifest.governance.url ? (
        <Notice kind="info">
          Read how this pod is governed: <a href={manifest.governance.url}>governance</a>.
        </Notice>
      ) : null}
    </Card>
  );
}
