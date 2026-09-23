'use client';

import { useState } from 'react';
import { Button, Card, Explain, Notice, TierBadge, type Tier } from '@passport/ui-kit';
import { acceptMembership, vacActions, type AckResult } from '@passport/pod-client';
import type { VerifiableCredential } from '@passport/credential-core';
import { useWalletState } from '../_lib/WalletContext';
import { ErrorNotice, describeAction, formatDate, tierLabel, useAction } from '../_lib/ui';

/**
 * Consent screen (principle 10: no membership without your signature). Shows the pod's grant — bioregion,
 * governance, validity — and signs the acknowledgement only when the person presses "I accept".
 */
export function Consent({ grant, onAccepted, onDecline }: { grant: VerifiableCredential; onAccepted?: (r: AckResult) => void; onDecline?: () => void }) {
  const w = useWalletState();
  const manifest = w.pod!.manifest;
  const [result, setResult] = useState<AckResult | null>(null);
  const s = grant.credentialSubject;

  const accept = useAction(async () => {
    const client = await w.clientFor();
    const r = await acceptMembership(w.wallet!, client, grant);
    setResult(r);
    await w.reload();
    onAccepted?.(r);
  });

  if (result) {
    const actions = [...new Set(result.vacs.flatMap(vacActions))];
    return (
      <Card className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-semibold">Welcome, neighbor.</h2>
          <TierBadge tier={result.member.tier as Tier} name={tierLabel(manifest, result.member.tier)} />
        </div>
        <Notice kind="success">
          You are now {/^[AEIOU]/i.test(tierLabel(manifest, result.member.tier)) ? 'an' : 'a'} {tierLabel(manifest, result.member.tier)} of {manifest.identity.name}.
        </Notice>
        <div>
          <h3 className="font-semibold">Why</h3>
          <ul className="mt-1 grid gap-1 text-sm">
            {result.explanation.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="font-semibold">What your passport now lets you do here</h3>
          <ul className="mt-1 grid gap-1 text-sm">
            {actions.map((a) => (
              <li key={a}>{describeAction(a)}</li>
            ))}
          </ul>
        </div>
        <p className="text-xs muted">These permissions are valid until {formatDate(result.vacs[0]?.validUntil)} and renew as long as you remain a member.</p>
      </Card>
    );
  }

  const bioregion = String(s['bioregion'] ?? manifest.identity.slug);
  return (
    <Card className="grid gap-4">
      <div>
        <p className="eyebrow">Membership offered</p>
        <h2 className="mt-1 text-2xl font-semibold">{manifest.identity.name} invites you to be a member</h2>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-[9rem_1fr]">
        <dt className="muted">Bioregion</dt>
        <dd>{bioregion === manifest.identity.slug ? manifest.identity.name : bioregion}</dd>
        <dt className="muted">Governed by</dt>
        <dd>
          {typeof s['governance'] === 'string' ? (
            <a href={String(s['governance'])} target="_blank" rel="noreferrer">
              the pod’s governance
            </a>
          ) : (
            'the pod’s published governance'
          )}
        </dd>
        <dt className="muted">Valid</dt>
        <dd>
          {formatDate(grant.validFrom)} to {formatDate(grant.validUntil)}
        </dd>
      </dl>
      <Explain>
        Membership exists only with your signature. Accepting signs an acknowledgement with your key on this device; you can leave later by letting it lapse.
      </Explain>
      <ErrorNotice error={accept.error} />
      <div className="flex flex-wrap gap-3">
        <Button size="lg" onClick={() => void accept.run()} disabled={accept.busy}>
          {accept.busy ? 'Signing…' : 'I accept'}
        </Button>
        {onDecline ? (
          <Button variant="ghost" onClick={onDecline}>
            Not now
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
