import type { TrustPolicy } from '@passport/tenant-config';
import { loadGraph, toDate, type PostingRow } from './graph.js';
import { isEndorsementScope } from './scorer.js';
import type { IndexContext, TrustGraph } from './types.js';

export type AnomalyKind = 'endorsement-velocity' | 'shared-witness-only';

/** A flag for steward review (FR-TR-3). Flags never revoke or downgrade anything. */
export interface AnomalyFlag {
  did: string;
  kind: AnomalyKind;
  detail: string;
  /** ISO timestamp of the earliest posting that contributes to the flag. */
  since: string;
}

const DAY_MS = 86_400_000;

/** Pure flag computation over loaded postings + graph. */
export function computeFlags(
  graph: TrustGraph,
  postings: readonly PostingRow[],
  policy: TrustPolicy,
  now: Date,
): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];
  const windowStart = now.getTime() - DAY_MS;
  const limit = policy.anomaly.endorsementVelocityPerDay;

  const recent = new Map<string, Date[]>();
  const witnessedAt = new Map<string, Date[]>();
  for (const p of postings) {
    const at = toDate(p.created_at);
    if (p.witnessed) {
      const list = witnessedAt.get(p.poster_did) ?? [];
      list.push(at);
      witnessedAt.set(p.poster_did, list);
    } else if (isEndorsementScope(p.scope) && at.getTime() > windowStart && at.getTime() <= now.getTime()) {
      const list = recent.get(p.poster_did) ?? [];
      list.push(at);
      recent.set(p.poster_did, list);
    }
  }

  for (const [did, times] of recent) {
    if (times.length > limit) {
      flags.push({
        did,
        kind: 'endorsement-velocity',
        detail: `${times.length} endorsements in the last 24 hours; the pod policy expects at most ${limit} per day.`,
        since: earliest(times),
      });
    }
  }

  if (policy.anomaly.sharedWitnessOnlyFlag) {
    for (const m of graph.members.values()) {
      if (m.witnessedEdges >= 2 && m.distinctConveners === 1) {
        flags.push({
          did: m.did,
          kind: 'shared-witness-only',
          detail: `All ${m.witnessedEdges} witnessed edges were witnessed by the same single convener.`,
          since: earliest(witnessedAt.get(m.did) ?? [now]),
        });
      }
    }
  }

  return flags.sort((a, b) => a.since.localeCompare(b.since) || a.did.localeCompare(b.did));
}

function earliest(times: readonly Date[]): string {
  return new Date(Math.min(...times.map((t) => t.getTime()))).toISOString();
}

/** `GET /steward/flags`: anomaly flags for steward review. */
export async function stewardFlags(ctx: IndexContext): Promise<AnomalyFlag[]> {
  const { graph, postings } = await loadGraph(ctx);
  return computeFlags(graph, postings, ctx.policy, ctx.now());
}
