/**
 * @passport/pod-vta — the pod's issuer and policy enforcement point (B2 §4.3, B3 §5/§9):
 * ceremony back half (event Trust Task documents, VWCs, membership grant/ack), VAC issuance from the trust
 * index recommendation (never downgrading mid-validity, FR-TR-2), revocation status list, disputes,
 * sign-in sessions, and the ADR-22 ceremony relay.
 */
export type { PodSigner, PodVtaDeps, IndexHooks, TierRecommendationLike, VtaContext, VtaRoute } from './types.js';
export { MemoryChallengeStore, DbChallengeStore, defaultChallengeStore, CHALLENGE_TTL_MS, podDomain, type ChallengeStore, type IssuedChallenge } from './challenges.js';
export {
  issueAuthorities,
  tierActions,
  refreshAuthorities,
  revokeAuthority,
  statusListCredential,
  statusListUrl,
  latestVac,
  validVacs,
  setEffective,
  recordGovernanceTier,
  stewardSetTier,
  logGovernance,
  governanceLog,
  VAC_STATUS_LIST,
  MIN_STATUS_BITS,
  REFRESH_WINDOW_DAYS,
  type IssuedAuthorities,
  type RefreshResult,
} from './pep.js';
export {
  SMOKE_PREFIX,
  MEETING_PREFIX,
  MEETING_DURATION_MS,
  createEvent,
  listEvents,
  getEvent,
  getEventFor,
  currentTier,
  MAX_SINCE_DAYS,
  witnessEdge,
  witnessMeeting,
  witnessVolume,
  abbreviateDid,
  WITNESS_VALIDITY_DAYS,
  type EventInput,
  type EventView,
  type EventKind,
  type MeetingPlace,
  type WitnessVolume,
  type MeetingSummary,
} from './events.js';
export { applyMembership, acknowledgeMembership, checkWitness, listMembers, getMember, type AckResult, type WitnessCheck } from './membership.js';
export { RELAY_MAX_PER_CHANNEL, RelayStore, defaultRelayStore, relayAppend, relayList, CHANNEL_RE, RELAY_TTL_MS, type RelayMessage } from './relay.js';
export { fileDispute, listDisputes, adjudicateDispute } from './disputes.js';
export { bootstrapSteward, ceremonyBackHalf, type CeremonyOptions, type CeremonyResult, type CeremonyDeps } from './ceremony.js';
export { createPodVtaRoutes, openSession, type SessionResponse } from './routes.js';
export { edgePairDigest, checkVrcPair, findPair, isMirroredPair } from './edges.js';
