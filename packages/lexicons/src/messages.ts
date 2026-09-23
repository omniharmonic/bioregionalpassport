/**
 * Ceremony and payment protocol messages (B3 §5, §6).
 *
 * Ceremony messages carry `createdAt` (ISO) and `seq` (a per-sender integer
 * sequence) so an offline outbox can replay them in order (B3 §5 "Offline
 * replay"). Payment messages carry their own timestamps per B3 §6 and are not
 * extended with `createdAt`/`seq`.
 */
import { z } from 'zod';
import { isoDateTime, QuantitySchema } from './common.js';

const ceremonyEnvelope = {
  createdAt: isoDateTime(),
  seq: z.int(),
};

// -- org.bioregion.oob.invite ---------------------------------------------------

export const OobInviteMessageSchema = z.object({
  type: z.literal('org.bioregion.oob.invite'),
  ...ceremonyEnvelope,
  pairwiseDid: z.string().min(1),
  challenge: z.string().min(1),
  pod: z.string().min(1),
  event: z.string().min(1).optional(),
});
export type OobInviteMessage = z.infer<typeof OobInviteMessageSchema>;

// -- org.bioregion.vrc.offer / .accept -------------------------------------------

export const VrcOfferMessageSchema = z.object({
  type: z.literal('org.bioregion.vrc.offer'),
  ...ceremonyEnvelope,
  vrc: z.unknown(),
  vec: z.unknown().optional(),
});
export type VrcOfferMessage = z.infer<typeof VrcOfferMessageSchema>;

export const VrcAcceptMessageSchema = z.object({
  type: z.literal('org.bioregion.vrc.accept'),
  ...ceremonyEnvelope,
  vrc: z.unknown(),
  vec: z.unknown().optional(),
});
export type VrcAcceptMessage = z.infer<typeof VrcAcceptMessageSchema>;

// -- org.bioregion.witness.request / .result -------------------------------------

export const WitnessRequestMessageSchema = z.object({
  type: z.literal('org.bioregion.witness.request'),
  ...ceremonyEnvelope,
  edgeDigest: z.string().min(1),
  taskContext: z.string().min(1),
  requester: z.string().min(1),
  /** The two signed RelationshipCredential halves of the witnessed edge (the convener forwards both to the VTA). */
  vrcA: z.unknown().optional(),
  vrcB: z.unknown().optional(),
});
export type WitnessRequestMessage = z.infer<typeof WitnessRequestMessageSchema>;

export const WitnessResultMessageSchema = z.object({
  type: z.literal('org.bioregion.witness.result'),
  ...ceremonyEnvelope,
  vwc: z.unknown(),
});
export type WitnessResultMessage = z.infer<typeof WitnessResultMessageSchema>;

// -- org.bioregion.event.attestation ---------------------------------------------

export const EventAttestationLocationSchema = z.object({
  placeId: z.string().min(1).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  name: z.string().min(1).optional(),
});

export const EventAttestationMessageSchema = z.object({
  type: z.literal('org.bioregion.event.attestation'),
  ...ceremonyEnvelope,
  id: z.string().min(1),
  pod: z.string().min(1),
  startsAt: isoDateTime(),
  endsAt: isoDateTime(),
  conveners: z.array(z.string().min(1)),
  location: EventAttestationLocationSchema,
});
export type EventAttestationMessage = z.infer<typeof EventAttestationMessageSchema>;
/** Alias per §4.1's Trust Task naming — same shape as `EventAttestationMessage`. */
export const EventAttestationDocumentSchema = EventAttestationMessageSchema;
export type EventAttestationDocument = EventAttestationMessage;

// -- org.bioregion.membership.apply / .grant / .ack -------------------------------

export const MembershipApplyMessageSchema = z.object({
  type: z.literal('org.bioregion.membership.apply'),
  ...ceremonyEnvelope,
  vic: z.unknown().optional(),
  vwc: z.unknown(),
  presentation: z.unknown(),
});
export type MembershipApplyMessage = z.infer<typeof MembershipApplyMessageSchema>;

export const MembershipGrantMessageSchema = z.object({
  type: z.literal('org.bioregion.membership.grant'),
  ...ceremonyEnvelope,
  grant: z.unknown(),
});
export type MembershipGrantMessage = z.infer<typeof MembershipGrantMessageSchema>;

export const MembershipAckMessageSchema = z.object({
  type: z.literal('org.bioregion.membership.ack'),
  ...ceremonyEnvelope,
  ack: z.unknown(),
});
export type MembershipAckMessage = z.infer<typeof MembershipAckMessageSchema>;

// -- org.bioregion.authority.issue / .revoke ---------------------------------------

export const AuthorityIssueMessageSchema = z.object({
  type: z.literal('org.bioregion.authority.issue'),
  ...ceremonyEnvelope,
  vacs: z.array(z.unknown()),
  explanation: z.array(z.string()),
});
export type AuthorityIssueMessage = z.infer<typeof AuthorityIssueMessageSchema>;

export const AuthorityRevokeMessageSchema = z.object({
  type: z.literal('org.bioregion.authority.revoke'),
  ...ceremonyEnvelope,
  digest: z.string().min(1),
  reason: z.string().min(1),
});
export type AuthorityRevokeMessage = z.infer<typeof AuthorityRevokeMessageSchema>;

// -- org.bioregion.index.commit -----------------------------------------------------

export const IndexCommitmentSchema = z.object({
  commitment: z.string().min(1),
  scope: z.string().min(1),
  witnessRef: z.string().min(1).optional(),
});
export type IndexCommitment = z.infer<typeof IndexCommitmentSchema>;

export const IndexCommitMessageSchema = z.object({
  type: z.literal('org.bioregion.index.commit'),
  ...ceremonyEnvelope,
  commitments: z.array(IndexCommitmentSchema),
});
export type IndexCommitMessage = z.infer<typeof IndexCommitMessageSchema>;

// -- org.bioregion.recovery.share / .request ----------------------------------------

export const RecoveryShareMessageSchema = z.object({
  type: z.literal('org.bioregion.recovery.share'),
  ...ceremonyEnvelope,
  share: z.unknown(),
});
export type RecoveryShareMessage = z.infer<typeof RecoveryShareMessageSchema>;

export const RecoveryRequestMessageSchema = z.object({
  type: z.literal('org.bioregion.recovery.request'),
  ...ceremonyEnvelope,
  requester: z.string().min(1),
});
export type RecoveryRequestMessage = z.infer<typeof RecoveryRequestMessageSchema>;

// -- payment protocol (B3 §6) -----------------------------------------------------

export const PayAcceptanceSchema = z.object({
  maxShare: z.number().min(0).max(1),
  requires: z.array(z.string().min(1)),
});
export type PayAcceptance = z.infer<typeof PayAcceptanceSchema>;

export const PayRequestMessageSchema = z.object({
  type: z.literal('org.bioregion.pay.request'),
  merchant: z.string().min(1),
  pod: z.string().min(1),
  node: z.string().min(1),
  amount: QuantitySchema,
  totalSale: QuantitySchema,
  invoice: z.string().min(1),
  expires: isoDateTime(),
  acceptance: PayAcceptanceSchema,
  sig: z.string().min(1).optional(),
});
export type PayRequestMessage = z.infer<typeof PayRequestMessageSchema>;

export const PayTransferSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  amount: QuantitySchema,
  invoice: z.string().min(1),
  createdAt: isoDateTime(),
});
export type PayTransfer = z.infer<typeof PayTransferSchema>;

export const PayAuthorizationMessageSchema = z.object({
  type: z.literal('org.bioregion.pay.authorization'),
  request: PayRequestMessageSchema,
  payer: z.string().min(1),
  transfer: PayTransferSchema,
  presentation: z.unknown(),
  sig: z.string().min(1).optional(),
});
export type PayAuthorizationMessage = z.infer<typeof PayAuthorizationMessageSchema>;

export const PosWriteBackSchema = z.object({
  status: z.enum(['pending', 'recorded', 'failed', 'n/a']),
  provider: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
});
export type PosWriteBack = z.infer<typeof PosWriteBackSchema>;

export const PayReceiptMessageSchema = z.object({
  type: z.literal('org.bioregion.pay.receipt'),
  transactionId: z.string().min(1),
  invoice: z.string().min(1),
  amount: QuantitySchema,
  totalSale: QuantitySchema,
  payer: z.string().min(1),
  payee: z.string().min(1),
  createdAt: isoDateTime(),
  posWriteBack: PosWriteBackSchema,
});
export type PayReceiptMessage = z.infer<typeof PayReceiptMessageSchema>;

// -- union -----------------------------------------------------------------------

export const MessageSchema = z.discriminatedUnion('type', [
  OobInviteMessageSchema,
  VrcOfferMessageSchema,
  VrcAcceptMessageSchema,
  WitnessRequestMessageSchema,
  WitnessResultMessageSchema,
  EventAttestationMessageSchema,
  MembershipApplyMessageSchema,
  MembershipGrantMessageSchema,
  MembershipAckMessageSchema,
  AuthorityIssueMessageSchema,
  AuthorityRevokeMessageSchema,
  IndexCommitMessageSchema,
  RecoveryShareMessageSchema,
  RecoveryRequestMessageSchema,
  PayRequestMessageSchema,
  PayAuthorizationMessageSchema,
  PayReceiptMessageSchema,
]);
export type Message = z.infer<typeof MessageSchema>;

/** Parse and validate a protocol message, dispatching on its `type` field. Throws `ZodError` on failure. */
export function parseMessage(input: unknown): Message {
  return MessageSchema.parse(input);
}
