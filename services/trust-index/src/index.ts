/**
 * @passport/trust-index — per-pod trust index (B3 §4, §9; PRD FR-TR-1..3).
 * Stores opted-in salted edge commitments, computes tier recommendations with
 * plain-language explanations, and raises anomaly flags for steward review.
 */
export type {
  Endorsement,
  IndexContext,
  MemberAggregate,
  MemberMetrics,
  RequirementResult,
  Scorer,
  TierRecommendation,
  TrustGraph,
} from './types.js';
export {
  V1Scorer,
  v1Scorer,
  computeScore,
  endorsementSum,
  hopFactor,
  spreadFactor,
  seedDistances,
  metricsFor,
  recommend,
  isEndorsementScope,
} from './scorer.js';
export { parseTierRequirement, evaluateRequirement, isGovernanceMetric } from './requirements.js';
export type { ParsedRequirement, ComparisonOp } from './requirements.js';
export { CommitBodySchema, COMMIT_SCOPES, MAX_WITNESS_CLAIMANTS, commitEdges, markWeighted } from './commit.js';
export type { CommitBody, CommitResult, CommitItemResult } from './commit.js';
export { computeFlags, stewardFlags } from './flags.js';
export type { AnomalyFlag, AnomalyKind } from './flags.js';
export { loadGraph } from './graph.js';
export { TRUST_INDEX_POD_SQL, ensureIndexTables } from './schema.js';
export { recommendTier, recomputeAll, createTrustIndexRoutes, createTrustIndexHandlers } from './service.js';
export type { TrustIndexDeps, RecomputeResult } from './service.js';
