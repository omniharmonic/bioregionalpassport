'use client';

import { Button, Card, Explain, Pill } from '@passport/ui-kit';
import { applyForMembership, optInToIndex, type ContactRow } from '@passport/pod-client';
import type { VerifiableCredential } from '@passport/credential-core';
import { useWalletState } from '../_lib/WalletContext';
import { ErrorNotice, Section, useAction } from '../_lib/ui';

/**
 * Witnessed relationships, wherever they were witnessed (at an event or by a Trusted neighbor on the spot):
 * a visitor applies for membership with one (the grant goes to the consent screen); a member may opt it in to
 * the trust index.
 */
export function WitnessedList({
  contacts,
  member,
  onGrant,
  onNote,
  onChanged,
}: {
  contacts: ContactRow[];
  member: boolean;
  onGrant: (grant: VerifiableCredential) => void;
  onNote: (note: string) => void;
  onChanged: () => Promise<void> | void;
}) {
  const w = useWalletState();

  const apply = useAction(async (contactDid: string) => {
    const client = await w.clientFor();
    onGrant(await applyForMembership(w.wallet!, client, contactDid));
  });

  const optIn = useAction(async (contactDid: string) => {
    const client = await w.clientFor();
    const r = await optInToIndex(w.wallet!, client, contactDid, 'relationship');
    onNote(r.accepted ? 'Counted. The trust index will include this relationship next time it explains your tier.' : 'This relationship was already counted.');
    await onChanged();
  });

  if (contacts.length === 0) return null;
  return (
    <Section title="Witnessed">
      <ErrorNotice error={apply.error ?? optIn.error} />
      <ul className="grid gap-3">
        {contacts.map((c) => (
          <li key={c.did}>
            <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
              <span>
                <span className="font-medium">{c.name ?? 'A neighbor'}</span> <Pill>Witnessed</Pill>
              </span>
              {!member ? (
                <Button onClick={() => void apply.run(c.did)} disabled={apply.busy}>
                  {apply.busy ? 'Applying…' : 'Apply for membership'}
                </Button>
              ) : c.committed?.some((x) => x.scope === 'relationship') ? (
                <span className="text-sm muted">Counted in the trust index</span>
              ) : (
                <Button variant="secondary" onClick={() => void optIn.run(c.did)} disabled={optIn.busy}>
                  Count it toward my trust (opt in)
                </Button>
              )}
            </Card>
          </li>
        ))}
      </ul>
      {member ? (
        <Explain>The trust index only sees a salted fingerprint of this relationship, and only if you choose to count it.</Explain>
      ) : (
        <Explain>Applying asks the pod for membership; nothing is final until you accept it with your own signature.</Explain>
      )}
    </Section>
  );
}
