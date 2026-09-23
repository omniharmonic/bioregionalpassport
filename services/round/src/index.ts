/**
 * @passport/round — grants rounds with quadratic voting (PRD F6, FR-GR-1..5; B3 §9): round lifecycle,
 * proposals, ballots signed by a per-round pseudonymous `did:key`, group votes through a delegation chain,
 * a tally anyone can recompute from the published ballots, steward adjustments with a published log, and
 * publication as `org.bioregion.project` records.
 */
export type { RoundContext, RoundRoute, RoundDeps, RoundStatus, Eligibility } from './types.js';
export { ROUND_STATUSES } from './types.js';
export {
  tally,
  voiceCost,
  ballotsHash,
  signedPart,
  sortBallots,
  ROUND_WEIGHTS,
  DEFAULT_VOICE_BUDGET,
  type Allocations,
  type SignedBallot,
  type PublishedBallot,
  type Tally,
  type TallyEntry,
  type TallyAdjustment,
  type TallyOptions,
} from './tally.js';
export {
  GROUP_TIER,
  voterHash,
  requirePodSession,
  publicTally,
  createRound,
  openRound,
  listRounds,
  getRound,
  createProposal,
  listProposals,
  submitBallot,
  publishedBallots,
  closeRound,
  addAdjustment,
  listAdjustments,
  publishRound,
  getTally,
  verifyTally,
  verifyRound,
  type RoundView,
  type ProposalView,
  type RoundInput,
  type ProposalInput,
  type BallotResult,
  type VerifyTallyResult,
} from './rounds.js';
export { createRoundRoutes, STEWARD_SCOPE } from './routes.js';
