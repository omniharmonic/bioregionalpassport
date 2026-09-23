'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, EmptyState, Explain, Field, Notice, PageHeader, Select } from '@passport/ui-kit';
import { ENDORSEMENT_SCOPES, optInToIndex, type ContactRow, type VouchScope } from '@passport/pod-client';
import { useWalletState } from '../_lib/WalletContext';
import { Did, ErrorNotice, Section, formatDate, scopeWords, useAction } from '../_lib/ui';

/**
 * F4 Vouch: contact → scope → sign → VEC delivered to them. Evidence only. Vouches you receive count in the trust
 * index only if you opt in (the index counts an endorsement for the person it was issued to).
 */
export default function VouchPage() {
  const w = useWalletState();
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [who, setWho] = useState('');
  const [scope, setScope] = useState<VouchScope>('knows');
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!w.wallet || !w.slug) return;
    try {
      const ceremony = await w.ceremonyFor();
      await ceremony.syncContacts();
    } catch {
      // Offline: show what is already here.
    }
    const list = await w.wallet.contacts(w.slug);
    setContacts(list);
    setWho((cur) => cur || list[0]?.did || '');
  }, [w]);
  useEffect(() => {
    void load();
  }, [load]);

  const sign = useAction(async () => {
    const ceremony = await w.ceremonyFor();
    const r = await ceremony.vouch(who, scope);
    const c = contacts.find((x) => x.did === who);
    setNote(`${r.queued ? 'Signed; it will be delivered when you are back online' : 'Signed and sent'}: you vouch that ${c?.name ?? 'they'} ${scopeWords(scope)}.`);
    await load();
  });

  const optIn = useAction(async (did: string) => {
    const client = await w.clientFor();
    const r = await optInToIndex(w.wallet!, client, did, 'vouch');
    setNote(r.accepted ? 'Counted: this vouch now informs your standing in the trust index.' : 'This vouch was already counted.');
    await load();
  });

  const received = contacts.filter((c) => c.vecIn);
  if (!w.pod) return null;
  return (
    <div className="grid gap-8">
      <PageHeader title="Vouch for a neighbor" subtitle="Say what you know about someone you have met. It is evidence, never a score." />
      {note ? <Notice kind="success">{note}</Notice> : null}
      {contacts.length === 0 ? (
        <EmptyState title="No neighbors yet" body="You can vouch for people you have met in person." />
      ) : (
        <Card className="grid gap-4">
          <Field label="Who" htmlFor="v-who">
            <Select id="v-who" value={who} onChange={(e) => setWho(e.target.value)}>
              {contacts.map((c) => (
                <option key={c.did} value={c.did}>
                  {c.name ?? `A neighbor met ${formatDate(c.formedAt)}`}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">What you vouch for</legend>
            {ENDORSEMENT_SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm">
                <input type="radio" name="v-scope" checked={scope === s} onChange={() => setScope(s)} /> They {scopeWords(s)}
              </label>
            ))}
          </fieldset>
          <ErrorNotice error={sign.error} />
          <div>
            <Button onClick={() => void sign.run()} disabled={sign.busy || !who}>
              Sign my vouch
            </Button>
          </div>
          <Explain>Your vouch is signed with your key and sent only to them; you can vouch again later with a different scope.</Explain>
        </Card>
      )}

      <Section title="Vouches you have received">
        <ErrorNotice error={optIn.error} />
        {received.length === 0 ? (
          <p className="text-sm muted">None yet. When a neighbor vouches for you, it arrives here.</p>
        ) : (
          <ul className="grid gap-3">
            {received.map((c) => {
              const s = c.vecIn?.credentialSubject?.['object']?.value?.scope;
              const counted = c.committed?.some((x) => x.scope === s);
              return (
                <li key={c.did}>
                  <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <span className="text-sm">
                      <strong>{c.name ?? 'A neighbor'}</strong> <Did did={c.did} /> vouches that you {scopeWords(s)}
                    </span>
                    {counted ? (
                      <span className="text-sm muted">Counted in the trust index</span>
                    ) : (
                      <Button variant="secondary" size="sm" onClick={() => void optIn.run(c.did)} disabled={optIn.busy}>
                        Opt in to the trust index
                      </Button>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
        <Explain>Opting in shares only a salted fingerprint of the vouch plus the signed vouch itself, so the pod can check it is real.</Explain>
      </Section>
    </div>
  );
}
