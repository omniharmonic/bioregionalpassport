import type { TrustPolicy } from '@passport/tenant-config';
import { loadGraph, toDate, type PostingRow } from './graph.js';
import { witnessPairsPerWeek } from './requirements.js';
import { isEndorsementScope } from './scorer.js';
import type { IndexContext, TrustGraph } from './types.js';

export type AnomalyKind = 'endorsement-velocity' | 'shared-witness-only' | 'witness-volume';

/** One witnessed pair as recorded by pod-vta (`witness_refs`), with who was admitted with it and the edge parties. */
export interface WitnessRow {
  digest: string;
  convener_did: string | null;
  created_at: Date | string;
  /** `events.kind` of the pair's task (`'meeting'` for peer witnessing); null when the task row is absent. */
  event_kind: string | null;
  /** DIDs admitted with this witness credential (`witness_refs.used_by`). */
  used_by: unknown;
  /** The stored VWC (`vta_witness_credentials.vwc`), for `credentialSubject.edgeParties`; null when absent. */
  vwc: unknown;
}

/** Hub flag: a witness with at least this many admitted members, none of them witnessed by anyone else. */
export const WITNESS_HUB_MIN_ADMITTED = 5;

/** Reads `witness_refs` directly (the index does not import pod-vta). */
export async function loadWitnessRows(ctx: IndexContext): Promise<WitnessRow[]> {
  return ctx.db.query<WitnessRow>(
    `SELECT w.digest, w.convener_did, w.created_at, w.used_by, e.kind AS event_kind, v.vwc
       FROM witness_refs w
       LEFT JOIN events e ON e.id = w.event_id
       LEFT JOIN vta_witness_credentials v ON v.digest = w.digest
      ORDER BY w.created_at, w.digest`,
  );
}

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
  witnesses: readonly WitnessRow[] = [],
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

  flags.push(...witnessVolumeFlags(witnesses, policy, now));

  return flags.sort((a, b) => a.since.localeCompare(b.since) || a.did.localeCompare(b.did));
}

function jsonArray(value: unknown): unknown[] {
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function edgeParties(vwc: unknown): string[] {
  const doc = (typeof vwc === 'string' ? safeParse(vwc) : vwc) as { credentialSubject?: { edgeParties?: unknown } } | null;
  return jsonArray(doc?.credentialSubject?.edgeParties).filter((d): d is string => typeof d === 'string');
}

/**
 * `witness-volume` flags (FR-TR-3; peer witnessing, Task 21b). Flags only — never revocation or downgrade.
 *
 * - Volume: a witness who witnessed more than `policy.anomaly.witnessPairsPerWeek` (default 20) pairs in the
 *   last 7 days, counting pairs at events and at meetings.
 * - Hub: a witness with at least five members admitted with their witness credentials (`witness_refs.used_by`)
 *   where none of those members has been witnessed by anyone else (as an admitted DID or an edge party of
 *   another witness's pair).
 */
export function witnessVolumeFlags(witnesses: readonly WitnessRow[], policy: TrustPolicy, now: Date): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];
  const limit = witnessPairsPerWeek(policy);
  const windowStart = now.getTime() - 7 * DAY_MS;

  const recent = new Map<string, { times: Date[]; meetings: number }>();
  const admittedBy = new Map<string, { dids: Set<string>; times: Date[] }>();
  const witnessedBy = new Map<string, Set<string>>(); // member DID → witnesses who witnessed them
  for (const w of witnesses) {
    const witness = w.convener_did;
    if (!witness) continue;
    const at = toDate(w.created_at);
    if (at.getTime() > windowStart && at.getTime() <= now.getTime()) {
      const r = recent.get(witness) ?? { times: [], meetings: 0 };
      r.times.push(at);
      if (w.event_kind === 'meeting') r.meetings++;
      recent.set(witness, r);
    }
    const admitted = jsonArray(w.used_by).filter((d): d is string => typeof d === 'string');
    if (admitted.length > 0) {
      const a = admittedBy.get(witness) ?? { dids: new Set<string>(), times: [] };
      for (const did of admitted) a.dids.add(did);
      a.times.push(at);
      admittedBy.set(witness, a);
    }
    for (const did of new Set([...admitted, ...edgeParties(w.vwc)])) {
      const set = witnessedBy.get(did) ?? new Set<string>();
      set.add(witness);
      witnessedBy.set(did, set);
    }
  }

  for (const [witness, { times, meetings }] of recent) {
    if (times.length > limit) {
      flags.push({
        did: witness,
        kind: 'witness-volume',
        detail:
          `${times.length} relationships witnessed in the last 7 days (${meetings} at meetings, ${times.length - meetings} at events); ` +
          `the pod policy expects at most ${limit} per week.`,
        since: earliest(times),
      });
    }
  }

  for (const [witness, { dids, times }] of admittedBy) {
    if (dids.size < WITNESS_HUB_MIN_ADMITTED) continue;
    const exclusive = [...dids].every((did) => [...(witnessedBy.get(did) ?? [])].every((other) => other === witness));
    if (exclusive) {
      flags.push({
        did: witness,
        kind: 'witness-volume',
        detail: `All ${dids.size} members admitted with this witness's credentials have been witnessed by no one else.`,
        since: earliest(times),
      });
    }
  }
  return flags;
}

function earliest(times: readonly Date[]): string {
  return new Date(Math.min(...times.map((t) => t.getTime()))).toISOString();
}

/** `GET /steward/flags`: anomaly flags for steward review. */
export async function stewardFlags(ctx: IndexContext): Promise<AnomalyFlag[]> {
  const { graph, postings } = await loadGraph(ctx);
  return computeFlags(graph, postings, ctx.policy, ctx.now(), await loadWitnessRows(ctx));
}
