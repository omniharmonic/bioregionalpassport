'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Notice } from '@passport/ui-kit';
import { PodError, abbreviateDid, messageOf, type CredentialRow } from '@passport/pod-client';
import { AUTHORITY_SCOPES } from '@passport/vocab';
import { copy, type BioregionManifest } from '@passport/tenant-config';

/** Every gate and failure: the server's one-sentence `message` (and its hint, when it gave one). */
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const hint = error instanceof PodError ? error.hint : undefined;
  return (
    <Notice kind="error">
      {messageOf(error)}
      {hint ? <span className="mt-1 block opacity-80">{hint}</span> : null}
    </Notice>
  );
}

/** An abbreviated identifier — never the whole DID outside the credential detail view. */
export function Did({ did }: { did: string | undefined | null }) {
  return <code className="text-xs">{abbreviateDid(did)}</code>;
}

export function formatDate(iso: string | undefined | null, withTime = false): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) });
}

export function isToday(iso: string | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

/** Runs an async action with busy/error state. */
export function useAction<A extends unknown[], T>(fn: (...args: A) => Promise<T>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ref = useRef(fn);
  ref.current = fn;
  const run = useCallback(async (...args: A): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await ref.current(...args);
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy, error, setError };
}

/** Polls `fn` every `ms` while `active`. */
export function usePoll(fn: () => Promise<unknown>, ms: number, active: boolean) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        await ref.current();
      } catch {
        // A failed poll is retried on the next tick.
      }
      if (!stopped) t = setTimeout(tick, ms);
    };
    void tick();
    return () => {
      stopped = true;
      if (t) clearTimeout(t);
    };
  }, [ms, active]);
}

/** Triggers a download of `text` as `filename`. */
export function downloadText(filename: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const ACTION_SENTENCES: Record<string, string> = {
  'event:attend': 'You can sign up for attestation events.',
  'vrc:exchange': 'You can form relationships with neighbors in this pod.',
  'vec:issue': 'You can vouch for neighbors.',
  'vec:issue:weighted': 'Your vouches carry weight in the trust index.',
  'round:comment': 'You can comment on grant proposals.',
  'round:vote': 'You can vote in grants rounds.',
  'round:propose': 'You can propose projects for grants.',
  'credit:account': 'You can open a local credit account.',
  'credit:limit:L1': 'Your credit line is the first band.',
  'credit:limit:L2': 'Your credit line is the second band.',
  'credit:limit:L3': 'Your credit line is the third band.',
  'vic:issue': 'You can invite a few people to attestation events.',
  'vic:issue:unlimited': 'You can invite people to attestation events without a limit.',
  'group:create': 'You can start a group.',
  'pay:receive': 'You can receive credits for an enterprise.',
  'event:convene': 'You can convene attestation events.',
  'vwc:issue': 'You can witness relationships formed at your events.',
  'pep:review': 'You can review trust decisions as a steward.',
  'registry:propose': 'You can propose changes to the pod registry.',
  'vmc:grant': 'You can co-sign admissions.',
  'did:witness': 'You can countersign changes to the pod identifier.',
};

/** Plain sentence for an authority action (B3 §3 scope). */
export function describeAction(action: string): string {
  const base = action.split('@')[0] ?? action;
  return ACTION_SENTENCES[base] ?? ((AUTHORITY_SCOPES as Record<string, { meaning: string }>)[base]?.meaning ?? action);
}

const SCOPE_WORDS: Record<string, string> = { 'lives-here': 'lives here', 'worked-with': 'worked with them', knows: 'knows them' };
export const scopeWords = (scope: unknown): string => SCOPE_WORDS[String(scope)] ?? String(scope);

export interface DescribeOpts {
  /** Local nickname of a contact. */
  nameOf?: (did: string) => string | undefined;
  /** True for this wallet's own identifiers. */
  mine?: (did: string) => boolean;
}

/** Title and one-sentence explanation of a held credential, in the pod's words. */
export function describeCredential(row: CredentialRow, manifest: BioregionManifest | undefined, opts: DescribeOpts = {}): { title: string; explain: string } {
  const pod = manifest?.identity.name ?? 'the pod';
  const s = row.raw.credentialSubject ?? ({} as Record<string, any>);
  const who = (did: string) => opts.nameOf?.(did) ?? 'a neighbor';
  switch (row.kind) {
    case 'membership-grant':
      return { title: `Membership granted by ${pod}`, explain: `${pod} offered you membership; it is complete once you sign your acknowledgement.` };
    case 'membership-ack':
      return { title: 'Your acknowledgement of membership', explain: `You accepted membership of ${pod}; together with the grant it shows you are a member.` };
    case 'relationship': {
      const mineHalf = opts.mine?.(row.issuer) ?? false;
      const other = mineHalf ? String(s.id ?? '') : row.issuer;
      return {
        title: `Relationship with ${who(other)}`,
        explain: `${mineHalf ? 'Your' : 'Their'} signed half of a relationship formed in person; a convener witnesses both halves together.`,
      };
    }
    case 'endorsement': {
      const given = opts.mine?.(row.issuer) ?? false;
      return {
        title: `${given ? 'Your vouch for' : 'Vouch from'} ${who(given ? String(s.id ?? '') : row.issuer)}: ${scopeWords(s['object']?.value?.scope)}`,
        explain: 'A vouch is evidence only; the person who receives it chooses whether to count it in the trust index.',
      };
    }
    case 'witness':
      return { title: 'Witnessed at an attestation event', explain: `${pod} recorded that a convener saw this relationship formed at one of its attestation events.` };
    case 'authority': {
      const tier = typeof s['tier'] === 'string' ? s['tier'] : '';
      return {
        title: `Permissions${tier ? ` (${manifest ? tierLabel(manifest, tier) : tier})` : ''}`,
        explain: `What ${pod} lets you do at your current tier, issued under its published trust policy.`,
      };
    }
    default:
      return { title: row.type.replace(/Credential$/, ''), explain: 'A credential held in your passport.' };
  }
}

export function tierLabel(manifest: BioregionManifest, tier: string): string {
  const name = copy(manifest, `tier.${tier}.name`);
  return name === `tier.${tier}.name` ? tier : name;
}
