import type { Db } from '@passport/db';
import type { PodContext } from '@passport/service-kit';
import type { BioregionManifest, TrustPolicy } from '@passport/tenant-config';
import type { Tier } from '@passport/vocab';

/** Pod context as seen by the trust index. */
export type IndexContext = PodContext<BioregionManifest, TrustPolicy, Db>;

/** One opted-in endorsement credited to a member (from a non-witnessed commitment with an endorsement scope). */
export interface Endorsement {
  scope: string;
  ageDays: number;
  /** Set when the endorser held `vec:issue:weighted` (≥ T2) — see README "weighted". */
  weighted: boolean;
}

/**
 * Per-member aggregate. The index never sees raw relationships: commitments are
 * salted hashes, so everything here is a count over a member's own postings.
 */
export interface MemberAggregate {
  did: string;
  /** A `members` row exists (VMC grant + ack complete). */
  vmcPairComplete: boolean;
  /** `members.tier` as recorded by the PEP or a steward/operator; `null` for non-members. */
  recordedTier: Tier | null;
  /** Distinct witness references across the member's witnessed postings. */
  witnessedEdges: number;
  distinctEvents: number;
  distinctConveners: number;
  endorsements: Endorsement[];
}

/**
 * The graph a scorer sees: member aggregates plus the opt-in adjacency from
 * `index_links` (`endorser → endorsed`, one row per opted-in weighted endorsement;
 * a documented MVP privacy deviation — see migration 0002_trust_index.sql).
 */
export interface TrustGraph {
  members: Map<string, MemberAggregate>;
  links: Map<string, Set<string>>;
}

export interface MemberMetrics {
  vmcPairComplete: boolean;
  recordedTier: Tier | null;
  witnessedEdges: number;
  distinctEvents: number;
  distinctConveners: number;
  endorsements: number;
  weightedEndorsements: number;
  /** E = Σ scopeWeight × 0.5^(age / half-life). */
  endorsementSum: number;
  /** `null` = not reachable from the seed set (∞). 0 when the seed set is empty (hop decay disabled). */
  seedHops: number | null;
  /** distinctEvents / max(witnessedEdges, 1), clipped to [0.5, 1]. */
  spread: number;
  /** D = hopDecay^seedHops. */
  hopFactor: number;
}

export interface RequirementResult {
  tier: Tier;
  requirement: string;
  met: boolean;
  sentence: string;
}

export interface TierRecommendation {
  did: string;
  tier: Tier;
  score: number;
  /** One plain sentence per requirement of the tiers up to and including the next tier. */
  explanation: string[];
  /** The next tier up and which requirement strings are not yet met (with a hint each). */
  next?: { tier: Tier; missing: string[]; hints: string[] };
  requirements: RequirementResult[];
  metrics: MemberMetrics;
}

/** Pluggable scorer. `compute` must be pure: same graph + policy ⇒ same output. */
export interface Scorer {
  compute(graph: TrustGraph, policy: TrustPolicy): Map<string, TierRecommendation>;
}
