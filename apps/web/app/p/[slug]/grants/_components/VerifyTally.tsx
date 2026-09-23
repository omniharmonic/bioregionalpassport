'use client';

import { useState } from 'react';
import { Button, Notice } from '@passport/ui-kit';
import { roundApi } from '../_lib/api';

interface VerifyResponse {
  ok: boolean;
  problems: string[];
  recomputed: { ballotCount: number; totalMatching: number; verifiable?: { ballotsHash: string } };
  stored: { ballotCount: number; totalMatching: number };
}

/** "Verify this tally": asks the pod to re-check every ballot signature and recompute the tally from scratch. */
export function VerifyTally({ slug, roundId }: { slug: string; roundId: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: 'success' | 'error' | 'warning'; text: string; problems?: string[] } | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    const res = await roundApi<VerifyResponse>(slug, `/rounds/${encodeURIComponent(roundId)}/verify`);
    setBusy(false);
    if (!res.ok) return setResult({ kind: 'error', text: res.message });
    const { ok, problems, recomputed } = res.data;
    setResult(
      ok
        ? {
            kind: 'success',
            text: `Verified: all ${recomputed.ballotCount} ballots are signed correctly and recomputing the tally gives the same result (${recomputed.totalMatching.toLocaleString('en-US')} matched).`,
          }
        : { kind: 'warning', text: 'The recomputed tally does not match what was published.', problems },
    );
  };

  return (
    <div className="grid gap-3">
      <div>
        <Button variant="secondary" onClick={run} disabled={busy}>
          {busy ? 'Checking…' : 'Verify this tally'}
        </Button>
      </div>
      {result ? (
        <Notice kind={result.kind}>
          <p>{result.text}</p>
          {result.problems?.length ? (
            <ul className="mt-2 list-disc pl-5">
              {result.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
    </div>
  );
}
