import type { TrustPolicy } from '@passport/tenant-config';
import { ENDORSEMENT_SCOPES, TIERS, type Tier } from '@passport/vocab';
import { evaluateRequirement } from './requirements.js';
import type {
  Endorsement,
  MemberAggregate,
  MemberMetrics,
  RequirementResult,
  Scorer,
  TierRecommendation,
  TrustGraph,
} from './types.js';

const ENDORSEMENT_SCOPE_SET: ReadonlySet<string> = new Set(ENDORSEMENT_SCOPES);

export function isEndorsementScope(scope: string): boolean {
  return ENDORSEMENT_SCOPE_SET.has(scope);
}

/**
 * Breadth-first distance from the seed set over `index_links` (`endorser →
 * endorsed`). A link exists only for a verified VEC from a member at T2 or
 * above that the endorsed member opted in, so you become reachable when someone
 * already reachable has endorsed you. Unreachable DIDs are absent (∞).
 */
export function seedDistances(links: Map<string, Set<string>>, seedSet: readonly string[]): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const seed of seedSet) {
    if (!dist.has(seed)) {
      dist.set(seed, 0);
      queue.push(seed);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i]!;
    const d = dist.get(from)!;
    for (const to of links.get(from) ?? []) {
      if (!dist.has(to)) {
        dist.set(to, d + 1);
        queue.push(to);
      }
    }
  }
  return dist;
}

/** E = Σ scopeWeights[scope] × 0.5^(ageDays / endorsementHalfLifeDays); unknown scopes weigh 0. */
export function endorsementSum(endorsements: readonly Endorsement[], policy: TrustPolicy): number {
  const halfLife = policy.weights.endorsementHalfLifeDays;
  let sum = 0;
  for (const e of endorsements) {
    const w = policy.weights.scopeWeights[e.scope] ?? 0;
    const decay = halfLife > 0 ? Math.pow(0.5, Math.max(0, e.ageDays) / halfLife) : 1;
    sum += w * decay;
  }
  return sum;
}

/** spread = distinctEvents / max(witnessedEdges, 1), clipped to [0.5, 1]. */
export function spreadFactor(distinctEvents: number, witnessedEdges: number): number {
  const raw = distinctEvents / Math.max(witnessedEdges, 1);
  return Math.min(1, Math.max(0.5, raw));
}

/**
 * D = hopDecay^seedHops. D = 1 at the seed (0 hops) and whenever the seed set is
 * empty (an empty seed set disables hop decay); D = 0 when unreachable.
 */
export function hopFactor(seedHops: number | null, hopDecay: number, seedSetEmpty: boolean): number {
  if (seedSetEmpty) return 1;
  if (seedHops === null) return 0;
  return Math.pow(hopDecay, seedHops);
}

/** FR-TR-1: score = D × (α·W + β·E) × R. */
export function computeScore(
  input: { witnessedEdges: number; endorsementSum: number; hopFactor: number; spread: number },
  policy: TrustPolicy,
): number {
  const { alpha, beta } = policy.weights;
  return input.hopFactor * (alpha * input.witnessedEdges + beta * input.endorsementSum) * input.spread;
}

export function metricsFor(
  member: MemberAggregate,
  distances: Map<string, number>,
  policy: TrustPolicy,
): MemberMetrics {
  const seedSetEmpty = policy.seedSet.length === 0;
  const seedHops = seedSetEmpty ? 0 : distances.get(member.did) ?? null;
  return {
    vmcPairComplete: member.vmcPairComplete,
    recordedTier: member.recordedTier,
    witnessedEdges: member.witnessedEdges,
    distinctEvents: member.distinctEvents,
    distinctConveners: member.distinctConveners,
    endorsements: member.endorsements.length,
    weightedEndorsements: member.endorsements.filter((e) => e.weighted).length,
    endorsementSum: endorsementSum(member.endorsements, policy),
    seedHops,
    spread: spreadFactor(member.distinctEvents, member.witnessedEdges),
    hopFactor: hopFactor(seedHops, policy.weights.hopDecay, seedSetEmpty),
  };
}

const LADDER: readonly Tier[] = TIERS.filter((t): t is Exclude<Tier, 'T0'> => t !== 'T0');

/**
 * Tier recommendation for one member. Each tier T1..T4 is evaluated on its own
 * requirement list; the recommendation is the highest tier whose requirements
 * all pass (never lower than T0). A DID without a completed membership pair is
 * always T0.
 */
export function recommend(member: MemberAggregate, metrics: MemberMetrics, policy: TrustPolicy): TierRecommendation {
  const seedSetEmpty = policy.seedSet.length === 0;
  const perTier = new Map<Tier, RequirementResult[]>();
  let tier: Tier = 'T0';
  for (const t of LADDER) {
    const requires = policy.tiers[t as 'T1' | 'T2' | 'T3' | 'T4'].requires;
    const results = requires.map((requirement) => ({
      tier: t,
      requirement,
      ...evaluateRequirement(requirement, { tier: t, metrics, seedSetEmpty }),
    }));
    perTier.set(t, results);
    if (results.every((r) => r.met) && metrics.vmcPairComplete) tier = t;
  }

  const rank = TIERS.indexOf(tier);
  const nextTier = TIERS[rank + 1];
  const shown: RequirementResult[] = [];
  for (const t of LADDER) {
    if (TIERS.indexOf(t) > (nextTier ? rank + 1 : rank)) break;
    shown.push(...(perTier.get(t) ?? []));
  }

  const rec: TierRecommendation = {
    did: member.did,
    tier,
    score: computeScore(metrics, policy),
    explanation: shown.map((r) => r.sentence),
    requirements: shown,
    metrics,
  };
  if (nextTier) {
    const failing = (perTier.get(nextTier) ?? []).filter((r) => !r.met);
    if (!metrics.vmcPairComplete && !failing.some((r) => r.requirement === 'vmcPairComplete')) {
      failing.unshift({
        tier: nextTier,
        requirement: 'vmcPairComplete',
        met: false,
        sentence: 'Your membership pair is not complete — finish joining the pod with a convener at an attestation event.',
      });
    }
    rec.next = { tier: nextTier, missing: failing.map((r) => r.requirement), hints: failing.map((r) => r.sentence) };
  }
  return rec;
}

/** v1 scorer: FR-TR-1 score + B3 §4 tier requirements with plain-language explanations. */
export class V1Scorer implements Scorer {
  compute(graph: TrustGraph, policy: TrustPolicy): Map<string, TierRecommendation> {
    const distances = seedDistances(graph.links, policy.seedSet);
    const out = new Map<string, TierRecommendation>();
    for (const member of graph.members.values()) {
      out.set(member.did, recommend(member, metricsFor(member, distances, policy), policy));
    }
    return out;
  }
}

export const v1Scorer: Scorer = new V1Scorer();

