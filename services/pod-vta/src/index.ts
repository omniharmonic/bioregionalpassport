/**
 * @passport/pod-vta — the pod's issuer and policy enforcement point (B2 §4.3, B3 §5/§9):
 * ceremony back half (event Trust Task documents, VWCs, membership grant/ack), VAC issuance from the trust
 * index recommendation (never downgrading mid-validity, FR-TR-2), revocation status list, disputes,
 * sign-in sessions, and the ADR-22 ceremony relay.
 */
export type { PodSigner, PodVtaDeps, IndexHooks, TierRecommendationLike, VtaContext, VtaRoute } from './types.js';
export { ChallengeStore, defaultChallengeStore, CHALLENGE_TTL_MS, podDomain, type IssuedChallenge } from './challenges.js';
export {
  issueAuthorities,
  refreshAuthorities,
  revokeAuthority,
  statusListCredential,
  statusListUrl,
  latestVac,
  validVacs,
  VAC_STATUS_LIST,
  MIN_STATUS_BITS,
  REFRESH_WINDOW_DAYS,
  type IssuedAuthorities,
  type RefreshResult,
} from './pep.js';
export { createEvent, listEvents, getEvent, witnessEdge, WITNESS_VALIDITY_DAYS, type EventInput, type EventView } from './events.js';
export { applyMembership, acknowledgeMembership, checkWitness, listMembers, getMember, type AckResult } from './membership.js';
export { RelayStore, defaultRelayStore, relayAppend, relayList, CHANNEL_RE, RELAY_TTL_MS, type RelayMessage } from './relay.js';
export { fileDispute, listDisputes, adjudicateDispute } from './disputes.js';
export { bootstrapSteward, ceremonyBackHalf, type CeremonyOptions, type CeremonyResult, type CeremonyDeps } from './ceremony.js';
export { createPodVtaRoutes, openSession, type SessionResponse } from './routes.js';
