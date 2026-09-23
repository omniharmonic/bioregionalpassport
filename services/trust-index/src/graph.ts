import { TIERS, type Tier } from '@passport/vocab';
import { isEndorsementScope } from './scorer.js';
import type { Endorsement, IndexContext, MemberAggregate, TrustGraph } from './types.js';

const DAY_MS = 86_400_000;

/** One opted-in posting joined with its commitment and (if witnessed) its witness reference. */
export interface PostingRow {
  poster_did: string;
  commitment: string;
  scope: string;
  witnessed: boolean;
  weighted: boolean;
  created_at: Date | string;
  /** Verified VEC issuer for evidence-backed endorsements; null otherwise. */
  endorser_did: string | null;
  witness_ref: string | null;
  event_id: string | null;
  convener_did: string | null;
  /**
   * `events.kind` of the witness reference's task: `'event'` (a scheduled gathering) or `'meeting'` (an ad-hoc
   * peer-witnessing Trust Task created by pod-vta `POST /witness`, Task 21a). `null` when the task row is absent
   * (pre-0011 refs, refs whose task was never stored): counted as an event, as before meetings existed.
   */
  event_kind: string | null;
}

/** True when the witness reference was made at an ad-hoc meeting rather than at a gathering. */
export function isMeeting(row: Pick<PostingRow, 'event_kind'>): boolean {
  return row.event_kind === 'meeting';
}

export async function loadPostings(ctx: IndexContext): Promise<PostingRow[]> {
  return ctx.db.query<PostingRow>(
    `SELECT p.poster_did, c.commitment, c.scope, p.witnessed, p.weighted, p.created_at,
            p.endorser_did, c.witness_ref, w.event_id, w.convener_did, e.kind AS event_kind
       FROM index_postings p
       JOIN edge_commitments c ON c.commitment = p.commitment
       LEFT JOIN witness_refs w ON w.digest = c.witness_ref
       LEFT JOIN events e ON e.id = w.event_id
      WHERE c.revoked_at IS NULL
      ORDER BY p.created_at, c.commitment`,
  );
}

function asTier(value: unknown): Tier | null {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value) ? (value as Tier) : null;
}

export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Builds per-member aggregates + adjacency for the whole pod (BFS needs the whole graph). */
export async function loadGraph(ctx: IndexContext): Promise<{ graph: TrustGraph; postings: PostingRow[] }> {
  const postings = await loadPostings(ctx);
  const memberRows = await ctx.db.query<{ did: string; tier: string; vmc_ack_digest: string | null; valid_until: Date | string | null }>(
    'SELECT did, tier, vmc_ack_digest, valid_until FROM members',
  );
  const linkRows = await ctx.db.query<{ from_did: string; to_did: string }>('SELECT from_did, to_did FROM index_links');
  const now = ctx.now().getTime();

  const members = new Map<string, MemberAggregate>();
  const witnessSets = new Map<string, { refs: Set<string>; events: Set<string>; meetings: Set<string>; conveners: Set<string> }>();
  const ensure = (did: string): MemberAggregate => {
    let m = members.get(did);
    if (!m) {
      m = {
        did,
        vmcPairComplete: false,
        membership: 'none',
        recordedTier: null,
        witnessedEdges: 0,
        distinctEvents: 0,
        distinctConveners: 0,
        meetings: 0,
        distinctWitnesses: 0,
        endorsements: [],
      };
      members.set(did, m);
      witnessSets.set(did, { refs: new Set(), events: new Set(), meetings: new Set(), conveners: new Set() });
    }
    return m;
  };

  for (const row of memberRows) {
    const m = ensure(row.did);
    // A pending applicant row (VTA inserts it at T0 before the ack) is not a complete pair.
    const acked = row.vmc_ack_digest !== null && row.vmc_ack_digest !== '';
    const expired = row.valid_until !== null && toDate(row.valid_until).getTime() <= now;
    m.membership = !acked ? 'pending' : expired ? 'expired' : 'complete';
    m.vmcPairComplete = m.membership === 'complete';
    // Governance tier only (steward/operator record): it feeds the governance requirements
    // (electedByGovernance, namedInGovernance), which the PEP effective tier must never satisfy
    // (that would be circular). Vouch weighting uses the standing tier at commit time (commit.ts `standingTier`).
    m.recordedTier = asTier(row.tier);
  }

  // At most one endorsement per (endorser, poster): postings are ordered by
  // created_at, so a later VEC from the same endorser replaces the earlier one.
  const byEndorser = new Map<string, Map<string, Endorsement>>();
  for (const p of postings) {
    const m = ensure(p.poster_did);
    if (p.witnessed && p.witness_ref) {
      const sets = witnessSets.get(p.poster_did)!;
      sets.refs.add(p.witness_ref);
      // Meetings are not events for spread: every peer-witnessed pair gets its own meeting task, so counting
      // them as events would make any member look spread across as many "events" as they have edges.
      if (p.event_id) (isMeeting(p) ? sets.meetings : sets.events).add(p.event_id);
      if (p.convener_did) sets.conveners.add(p.convener_did);
    } else if (isEndorsementScope(p.scope)) {
      const endorsement: Endorsement = {
        scope: p.scope,
        ageDays: Math.max(0, (now - toDate(p.created_at).getTime()) / DAY_MS),
        weighted: p.weighted,
      };
      if (p.endorser_did) {
        let perPoster = byEndorser.get(p.poster_did);
        if (!perPoster) byEndorser.set(p.poster_did, (perPoster = new Map()));
        perPoster.set(p.endorser_did, endorsement);
      } else {
        m.endorsements.push(endorsement);
      }
    }
  }
  for (const [did, perPoster] of byEndorser) members.get(did)!.endorsements.push(...perPoster.values());
  for (const [did, sets] of witnessSets) {
    const m = members.get(did)!;
    m.witnessedEdges = sets.refs.size;
    m.distinctEvents = sets.events.size;
    m.distinctConveners = sets.conveners.size;
    m.meetings = sets.meetings.size;
    // The witness of a pair is the convener recorded on its witness ref (the event convener, or the peer who
    // witnessed a meeting), so today this is the same set as `distinctConveners`, across events and meetings.
    m.distinctWitnesses = sets.conveners.size;
  }

  const links = new Map<string, Set<string>>();
  for (const { from_did, to_did } of linkRows) {
    let set = links.get(from_did);
    if (!set) links.set(from_did, (set = new Set()));
    set.add(to_did);
  }
  return { graph: { members, links }, postings };
}
