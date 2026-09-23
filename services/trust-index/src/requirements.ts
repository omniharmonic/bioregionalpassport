import type { TrustPolicy } from '@passport/tenant-config';
import { isAtLeast, type Tier } from '@passport/vocab';
import type { MemberMetrics } from './types.js';

export type ComparisonOp = '>=' | '<=' | '>' | '<' | '=';

/**
 * A parsed tier requirement. Grammar (generic, B3 §4 `tiers.*.requires`):
 *   requirement := metric op number [unit] | flag
 *   metric/flag := [A-Za-z][A-Za-z0-9]*      op := >= | <= | > | < | = | ==
 *   unit        := d  (days; only meaningful on governance metrics like `T2for>=180d`)
 */
export type ParsedRequirement =
  | { kind: 'compare'; raw: string; metric: string; op: ComparisonOp; value: number; unit?: string }
  | { kind: 'flag'; raw: string; metric: string }
  | { kind: 'invalid'; raw: string };

const COMPARE_RE = /^([A-Za-z][A-Za-z0-9]*)\s*(>=|<=|==|=|>|<)\s*(\d+(?:\.\d+)?)\s*([a-z]*)$/;
const FLAG_RE = /^[A-Za-z][A-Za-z0-9]*$/;

export function parseTierRequirement(raw: string): ParsedRequirement {
  const text = raw.trim();
  const m = COMPARE_RE.exec(text);
  if (m) {
    const op = (m[2] === '==' ? '=' : m[2]) as ComparisonOp;
    const parsed: ParsedRequirement = { kind: 'compare', raw, metric: m[1]!, op, value: Number(m[3]) };
    if (m[4]) parsed.unit = m[4];
    return parsed;
  }
  if (FLAG_RE.test(text)) return { kind: 'flag', raw, metric: text };
  return { kind: 'invalid', raw };
}

function compare(actual: number, op: ComparisonOp, value: number): boolean {
  switch (op) {
    case '>=':
      return actual >= value;
    case '<=':
      return actual <= value;
    case '>':
      return actual > value;
    case '<':
      return actual < value;
    case '=':
      return actual === value;
  }
}

/**
 * Policy fields this index reads before the policy schema declares them (Task 21b; the schema task makes them
 * explicit). Read defensively: an older policy without them gets the defaults.
 *   admission.peerWitnessing      boolean, default true  — see `effectiveRequirement`
 *   anomaly.witnessPairsPerWeek   number,  default 20    — see flags.ts `witness-volume`
 */
interface PeerWitnessingPolicyFields {
  admission?: { peerWitnessing?: boolean };
  anomaly?: { witnessPairsPerWeek?: number };
}

/** `policy.admission?.peerWitnessing !== false` (default true). */
export function peerWitnessingEnabled(policy: TrustPolicy): boolean {
  return (policy as unknown as PeerWitnessingPolicyFields).admission?.peerWitnessing !== false;
}

/** `policy.anomaly?.witnessPairsPerWeek ?? 20`. */
export const DEFAULT_WITNESS_PAIRS_PER_WEEK = 20;
export function witnessPairsPerWeek(policy: TrustPolicy): number {
  const v = (policy as unknown as PeerWitnessingPolicyFields).anomaly?.witnessPairsPerWeek;
  return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_WITNESS_PAIRS_PER_WEEK;
}

/**
 * Compatibility rule (Task 21b): when peer witnessing is on (`admission.peerWitnessing !== false`, the default),
 * a T2 requirement `distinctEvents>=N` is evaluated as `distinctEventsOrWitnesses>=N` — N different witnesses
 * or gatherings, whichever is larger. Existing pods get peer-to-peer spread without editing their policy;
 * events stay an optional, stronger signal. With `peerWitnessing: false`, or on any other tier or operator,
 * the requirement is evaluated exactly as written. The schema task will make this explicit in the policy.
 */
export function effectiveRequirement(tier: Tier, raw: string, policy: TrustPolicy): string {
  if (tier !== 'T2' || !peerWitnessingEnabled(policy)) return raw;
  const req = parseTierRequirement(raw);
  if (req.kind !== 'compare' || req.metric !== 'distinctEvents' || req.op !== '>=' || req.unit) return raw;
  return `distinctEventsOrWitnesses>=${req.value}`;
}

/**
 * Governance requirements are never computed: they are satisfied only when a
 * steward/operator has recorded `members.tier` at or above the tier being
 * evaluated (after an election, a naming, or a tenure check).
 */
export function isGovernanceMetric(metric: string): boolean {
  return metric === 'electedByGovernance' || metric === 'namedInGovernance' || /^T[0-4]for$/.test(metric);
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function word(n: number): string {
  return WORDS[n] ?? String(n);
}
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
function fmt(x: number): string {
  return String(Math.round(x * 100) / 100);
}

export interface EvaluateInput {
  tier: Tier;
  metrics: MemberMetrics;
  /** True when the policy seed set is empty: hop distance is not checked. */
  seedSetEmpty: boolean;
}

/** Evaluates one requirement string for a member and explains it in one plain sentence. */
export function evaluateRequirement(raw: string, input: EvaluateInput): { met: boolean; sentence: string } {
  const req = parseTierRequirement(raw);
  const { metrics: m, tier } = input;

  if (req.kind === 'invalid') {
    return { met: false, sentence: `The policy requirement "${raw}" is not understood, so it cannot be met until the policy is corrected.` };
  }

  if (isGovernanceMetric(req.metric)) {
    const met = m.recordedTier !== null && isAtLeast(m.recordedTier, tier);
    const label = governanceLabel(req);
    return met
      ? { met, sentence: `${label}: recorded by a steward (your recorded tier is ${m.recordedTier}).` }
      : {
          met,
          sentence: `${label}: not recorded — a steward or operator records this after a governance decision; the index never computes it.`,
        };
  }

  if (req.kind === 'flag') {
    if (req.metric === 'vmcPairComplete') {
      return m.vmcPairComplete
        ? { met: true, sentence: 'Your membership pair is complete.' }
        : { met: false, sentence: membershipSentence(m.membership) };
    }
    return { met: false, sentence: `The policy flag "${req.metric}" is not something the index knows how to check, so it cannot be met.` };
  }

  const { metric, op, value } = req;
  switch (metric) {
    case 'witnessedEdges':
      return countSentence(m.witnessedEdges, op, value, 'witnessed edge', 'witnessed edges', (short) =>
        `get ${word(short)} more ${plural(short, 'relationship', 'relationships')} witnessed by a convener at an attestation event`,
      );
    case 'distinctEvents':
      return countSentence(m.distinctEvents, op, value, 'distinct event', 'distinct events', (short) =>
        `attend ${word(short)} more attestation ${plural(short, 'event', 'events')}`,
      );
    case 'distinctWitnesses':
      return countSentence(m.distinctWitnesses, op, value, 'different witness', 'different witnesses', askWitness);
    case 'distinctEventsOrWitnesses':
      return countSentence(
        Math.max(m.distinctEvents, m.distinctWitnesses),
        op,
        value,
        'different witness or gathering',
        'different witnesses or gatherings',
        askWitness,
      );
    case 'distinctConveners':
      return countSentence(m.distinctConveners, op, value, 'distinct convener', 'distinct conveners', (short) =>
        `have ${word(short)} more ${plural(short, 'relationship', 'relationships')} witnessed by a different convener`,
      );
    case 'weightedEndorsements':
      return countSentence(m.weightedEndorsements, op, value, 'weighted endorsement', 'weighted endorsements', (short) =>
        `ask ${word(short)} more trusted ${plural(short, 'neighbor', 'neighbors')} (T2 or above) to vouch for you`,
      );
    case 'endorsements':
      return countSentence(m.endorsements, op, value, 'endorsement', 'endorsements', (short) =>
        `ask ${word(short)} more ${plural(short, 'neighbor', 'neighbors')} to vouch for you`,
      );
    case 'seedHops': {
      if (input.seedSetEmpty) {
        return { met: true, sentence: 'This pod has no seed set yet, so distance from the seed set is not checked.' };
      }
      const hops = m.seedHops;
      const need = `${fmt(value)} or fewer needed`;
      if (hops === null) {
        const met = compare(Number.POSITIVE_INFINITY, op, value);
        return {
          met,
          sentence: met
            ? 'You are not connected to the seed set, which this requirement allows.'
            : `You are not yet connected to the seed set (${need}) — link a relationship with a member who is.`,
        };
      }
      const met = compare(hops, op, value);
      const base = `${hops} ${plural(hops, 'hop', 'hops')} from the seed set (${op === '<=' ? need : `${op} ${fmt(value)} needed`})`;
      return met
        ? { met, sentence: `${base}.` }
        : { met, sentence: `${base} — link a relationship with a member closer to the pod's founding members.` };
    }
    case 'spread': {
      const met = compare(m.spread, op, value);
      const base = `Spread across different witnesses and events is ${fmt(m.spread)} (${op} ${fmt(value)} needed)`;
      return met
        ? { met, sentence: `${base}.` }
        : { met, sentence: `${base} — have relationships witnessed by different neighbors or at different events.` };
    }
    case 'score':
      return {
        met: false,
        sentence: `Score thresholds are evaluated by the scorer, not in requirement lists ("${raw}").`,
      };
    default:
      return { met: false, sentence: `The policy metric "${metric}" is not something the index knows how to check, so it cannot be met.` };
  }
}

function askWitness(short: number): string {
  return short === 1
    ? 'ask another neighbor to witness a relationship'
    : `ask ${word(short)} more neighbors to each witness a relationship`;
}

/** Plain sentence for an incomplete membership pair. */
export function membershipSentence(status: MemberMetrics['membership']): string {
  switch (status) {
    case 'pending':
      return 'Your membership is not complete until you acknowledge the grant.';
    case 'expired':
      return 'Your membership has expired — renew it with the pod to regain your tier.';
    case 'complete':
      return 'Your membership pair is complete.';
    default:
      return 'Your membership pair is not complete — finish joining the pod with a convener at an attestation event.';
  }
}

function governanceLabel(req: ParsedRequirement): string {
  if (req.kind === 'invalid') return req.raw;
  if (req.metric === 'electedByGovernance') return 'Elected by governance';
  if (req.metric === 'namedInGovernance') return 'Named in governance';
  if (req.kind === 'compare') {
    const tier = req.metric.slice(0, 2);
    const unit = req.unit === 'd' ? (req.value === 1 ? 'day' : 'days') : req.unit ?? '';
    return `Held ${tier} for at least ${fmt(req.value)} ${unit}`.trim();
  }
  return req.metric;
}

function countSentence(
  actual: number,
  op: ComparisonOp,
  value: number,
  one: string,
  many: string,
  hint: (short: number) => string,
): { met: boolean; sentence: string } {
  const met = compare(actual, op, value);
  if (op === '>=' || op === '>') {
    const needed = op === '>=' ? value : value + 1;
    if (met) {
      return {
        met,
        sentence:
          actual > needed
            ? `${actual} ${many} (${fmt(needed)} needed).`
            : `${actual} of ${fmt(needed)} ${needed === 1 ? one : many}.`,
      };
    }
    const short = Math.max(1, Math.ceil(needed - actual));
    return { met, sentence: `${actual} of ${fmt(needed)} ${needed === 1 ? one : many} — ${hint(short)}.` };
  }
  return { met, sentence: `${actual} ${actual === 1 ? one : many} (${op} ${fmt(value)} needed)${met ? '' : ' — this is above what the policy allows'}.` };
}

