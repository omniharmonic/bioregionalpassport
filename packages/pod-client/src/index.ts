/**
 * @passport/pod-client — the browser wallet engine (ADR-25) and client for pod services (ADR-22/26).
 * Browser-safe: IndexedDB via Dexie, WebCrypto, @noble; no Node APIs.
 */
export { DEFAULT_DB_NAME, WalletDb, type ContactRow, type CredentialRow, type EventRow, type IdentifierRow, type OutboxRow, type PodExplanation, type PodRow, type SettingRow } from './db.js';
export { Wallet, createWallet, openWallet, type WalletOptions } from './wallet.js';
export { Outbox, ensureOk, type FetchLike, type HttpRequest, type SendResult } from './outbox.js';
export {
  PodClient,
  isSameOrigin,
  listRegistryPods,
  fetchPodManifest,
  type AckResult,
  type CommitItem,
  type PodClientOptions,
  type PodEvent,
  type RefreshResult,
  type ServiceName,
  type SessionInfo,
} from './client.js';
export { CHANNEL_RE, MemoryRelay, type RelayMessage, type RelayTransport } from './relay.js';
export {
  Ceremony,
  ENDORSEMENT_SCOPES,
  pairDigest,
  parseInvite,
  type CeremonyOptions,
  type HostSession,
  type JoinSession,
  type Met,
  type RelationshipIdentity,
  type VouchScope,
  type WitnessRequest,
} from './ceremony.js';
export { signIn, withSession, applyForMembership, acceptMembership, refreshTier, optInToIndex, commitmentFor } from './membership.js';
export { exportBackup, importBackup, createShares, recoverFromShares, recoveryStatus, exportCredentialsJson, BACKUP_FORMAT, SHARE_PREFIX } from './recovery.js';
export { parsePaymentRequest, buildPayAuthorization, payRequest } from './pay.js';
export {
  PodError,
  messageOf,
  abbreviateDid,
  channelFor,
  eventChannel,
  platformDomainOf,
  podDomainOf,
  dtgType,
  credentialKind,
  isCurrent,
  vacActions,
  isOnline,
  type CredentialKind,
} from './util.js';
