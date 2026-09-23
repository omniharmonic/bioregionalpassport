'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Button, Card, EmptyState, Explain, Notice, Pill, TierBadge, type Tier } from '@passport/ui-kit';
import { eventChannel, recoveryStatus, refreshTier, type ContactRow, type CredentialRow, type EventRow } from '@passport/pod-client';
import { copy } from '@passport/tenant-config';
import { describeRule } from '@/lib/podCopy';
import { useWalletState } from '../_lib/WalletContext';
import { Did, ErrorNotice, Section, describeCredential, formatDate, tierLabel, useAction } from '../_lib/ui';

/** Pod home inside the wallet: tier, why, what would change it, credentials, contacts, events, one CTA. */
export function PodHome() {
  const w = useWalletState();
  const pod = w.pod!;
  const manifest = pod.manifest;
  const [creds, setCreds] = useState<CredentialRow[]>([]);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [allContacts, setAllContacts] = useState<ContactRow[]>([]);
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [events, setEvents] = useState<EventRow[]>([]);
  const [member, setMember] = useState(false);
  const [missingKeys, setMissingKeys] = useState(0);
  const [showWhy, setShowWhy] = useState(false);

  useEffect(() => {
    const wallet = w.wallet;
    if (!wallet) return;
    let live = true;
    (async () => {
      const [c, all, ids, cached, pair, status] = await Promise.all([
        wallet.credentials(),
        wallet.contacts(),
        wallet.identifiers(),
        wallet.events(pod.slug),
        wallet.membership(pod.slug),
        recoveryStatus(wallet),
      ]);
      if (!live) return;
      setCreds(c);
      setAllContacts(all);
      setContacts(all.filter((x) => x.pod === pod.slug));
      setMine(new Set(ids.map((i) => i.did)));
      setEvents(cached);
      setMember(!!pair);
      setMissingKeys(status.newKeysSinceBackup);
    })();
    return () => {
      live = false;
    };
  }, [w.wallet, w.version, pod.slug]);

  // Upcoming events from the pod (cached for offline use).
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const client = await w.clientFor(pod.slug);
        const list = await client.events();
        const rows: EventRow[] = list
          .filter((e) => e.startsAt)
          .map((e) => ({
            id: e.id,
            pod: pod.slug,
            title: e.title,
            startsAt: e.startsAt!,
            ...(e.endsAt ? { endsAt: e.endsAt } : {}),
            conveners: e.conveners,
            attestation: e.attestation,
            placeId: e.placeId,
            ...(e.taskDigest ? { taskDigest: e.taskDigest, channel: eventChannel({ id: e.id, taskDigest: e.taskDigest }) } : {}),
          }));
        await w.wallet?.putEvents(rows);
        if (live) setEvents(rows);
      } catch {
        // Offline: keep the cached list.
      }
    })();
    return () => {
      live = false;
    };
  }, [w, pod.slug]);

  const why = useAction(async () => {
    setShowWhy(true);
    if (!member) return;
    const client = await w.clientFor(pod.slug);
    await refreshTier(w.wallet!, client);
    await w.reload();
  });

  const tier = (pod.tier ?? 'T0') as Tier;
  const tierName = tierLabel(manifest, tier);
  const exp = pod.lastExplanation;
  const nextHints = exp?.next ? (exp.next.hints.length ? exp.next.hints : exp.next.missing.map((m) => describeRule(manifest, m))) : [];
  const nameOf = (did: string) => allContacts.find((c) => c.did === did)?.name;
  const upcoming = events.filter((e) => !e.endsAt || Date.parse(e.endsAt) > Date.now()).slice(0, 3);

  const byPod = useMemo(() => {
    const order = [pod.slug, ...w.pods.map((p) => p.slug).filter((s) => s !== pod.slug)];
    return order.map((slug) => ({ slug, manifest: w.pods.find((p) => p.slug === slug)?.manifest, rows: creds.filter((c) => c.pod === slug && c.status !== 'superseded') }));
  }, [creds, pod.slug, w.pods]);

  return (
    <div className="grid gap-10">
      <Card className="grid gap-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow">Your passport in</p>
            <h1 className="mt-1 text-3xl font-semibold">{manifest.identity.name}</h1>
            <p className="mt-2 text-sm muted">
              Your identifier here <Did did={pod.personaDid} />
            </p>
          </div>
          <TierBadge tier={tier} name={tierName} className="text-sm" />
        </div>

        <div className="flex flex-wrap gap-3">
          <Button size="lg" href={w.href('/wallet/events')}>
            {copy(manifest, 'cta.findEvent')}
          </Button>
          <Button variant="secondary" onClick={() => void why.run()} disabled={why.busy} aria-expanded={showWhy}>
            {why.busy ? 'Asking the pod…' : 'Why this tier'}
          </Button>
        </div>
        <ErrorNotice error={why.error} />

        {showWhy ? (
          member ? (
            <div className="grid gap-4">
              <div>
                <h2 className="text-base font-semibold">Why you are {tierName.toLowerCase().startsWith('a') ? 'an' : 'a'} {tierName}</h2>
                <ul className="mt-2 grid gap-1 text-sm">
                  {(exp?.explanation ?? ['Your membership pair is complete.']).map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
              {exp?.next && nextHints.length ? (
                <div>
                  <h2 className="text-base font-semibold">What would change it</h2>
                  <p className="text-sm muted">To become {tierLabel(manifest, exp.next.tier)}:</p>
                  <ul className="mt-2 grid gap-1 text-sm">
                    {nextHints.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {exp ? <p className="text-xs muted">Checked {formatDate(exp.at, true)}.</p> : null}
            </div>
          ) : (
            <div className="grid gap-3 text-sm">
              <h2 className="text-base font-semibold">Why you are a {tierName}</h2>
              <p>You have joined {manifest.identity.name}, but membership is only given in person, at an attestation event.</p>
              <h2 className="text-base font-semibold">What would change it</h2>
              <p>
                Meet a neighbor, then ask a convener to witness your new relationship at an attestation event. When the pod grants membership, you accept it
                with your own signature.
              </p>
            </div>
          )
        ) : null}
      </Card>

      {missingKeys > 0 ? (
        <Notice kind="warning">
          Your recovery kit does not cover {missingKeys === 1 ? 'one of your keys' : `${missingKeys} of your keys`} yet.{' '}
          <Link href={w.href('/wallet/settings')}>Download a fresh backup</Link>.
        </Notice>
      ) : null}
      {w.pendingOutbox > 0 ? (
        <Notice kind="info">
          {w.pendingOutbox === 1 ? 'One message is' : `${w.pendingOutbox} messages are`} waiting to be sent.{' '}
          <button type="button" className="underline" onClick={() => void w.flushOutbox()}>
            Send now
          </button>
        </Notice>
      ) : null}

      <Section title="Upcoming events" aside={<Link href={w.href('/wallet/events')}>All events</Link>}>
        {upcoming.length === 0 ? (
          <EmptyState title="No gatherings on the calendar" body="Conveners post attestation events here. Check back soon." />
        ) : (
          <ul className="grid gap-3">
            {upcoming.map((e) => (
              <li key={e.id}>
                <Link href={w.href(`/wallet/events?event=${encodeURIComponent(e.id)}`)} className="no-underline" style={{ color: 'var(--bp-fg)' }}>
                  <Card className="flex flex-wrap items-center justify-between gap-2 p-4">
                    <span className="font-medium">{e.title}</span>
                    <span className="flex items-center gap-2 text-sm muted">
                      {formatDate(e.startsAt, true)}
                      {e.attestation ? <Pill>Attestation</Pill> : null}
                    </span>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Neighbors" aside={<Link href={w.href('/wallet/meet')}>Meet a neighbor</Link>}>
        {contacts.length === 0 ? (
          <EmptyState title="No neighbors yet" body="When you meet someone in person, you exchange signed relationship credentials here." />
        ) : (
          <ul className="grid gap-3">
            {contacts.map((c) => (
              <li key={c.did}>
                <Card className="flex flex-wrap items-center justify-between gap-2 p-4">
                  <span>
                    <span className="font-medium">{c.name ?? 'A neighbor'}</span> <Did did={c.did} />
                    <span className="block text-xs muted">Met {formatDate(c.formedAt)}</span>
                  </span>
                  <span className="flex flex-wrap gap-2">
                    {c.vwc ? <Pill>Witnessed</Pill> : null}
                    {c.vecIn ? <Pill>Vouched for you</Pill> : null}
                    {c.vecOut ? <Pill>You vouched</Pill> : null}
                  </span>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Credentials">
        {byPod.every((g) => g.rows.length === 0) ? (
          <EmptyState title="No credentials yet" body="Credentials arrive when you meet neighbors, are vouched for, and are admitted by a pod." />
        ) : (
          byPod
            .filter((g) => g.rows.length)
            .map((g) => (
              <div key={g.slug} className="grid gap-2">
                <h3 className="text-sm font-semibold muted">{g.manifest?.identity.name ?? g.slug}</h3>
                <ul className="grid gap-2">
                  {g.rows.map((row) => {
                    const d = describeCredential(row, g.manifest, { nameOf, mine: (did) => mine.has(did) });
                    const issuer = row.issuer === g.manifest?.identity.did ? g.manifest.identity.name : mine.has(row.issuer) ? 'You' : (nameOf(row.issuer) ?? 'A neighbor');
                    return (
                      <li key={row.digest}>
                        <Link href={w.href(`/wallet/credentials/${encodeURIComponent(row.digest)}`)} className="no-underline" style={{ color: 'var(--bp-fg)' }}>
                          <Card className="grid gap-1 p-4">
                            <span className="font-medium">{d.title}</span>
                            <span className="text-xs muted">
                              {row.type.replace(/Credential$/, '')} · from {issuer}
                              {row.validUntil ? ` · valid until ${formatDate(row.validUntil)}` : ''}
                            </span>
                          </Card>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
        )}
      </Section>
      <Explain>Every credential here is held on this device; the pod sees one only when you present it.</Explain>
    </div>
  );
}
