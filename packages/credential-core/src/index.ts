export {
  canonicalize,
  digestMultibase,
  randomNonce,
  toBase58btc,
  fromBase58btc,
  toBase64url,
  fromBase64url,
} from './encoding.js';
export {
  type DidScope,
  type KeyPair,
  generateKeyPair,
  keyPairFromSeed,
  deriveRoundKey,
  keyPairForDid,
  publicKeyToMultibase,
  publicKeyFromMultibase,
  didKeyFromMultibase,
  multibaseFromDidKey,
} from './keys.js';
export {
  type DidDocument,
  type DidResolver,
  type VerificationMethod,
  createResolver,
  didKeyDocument,
  didWebDocument,
  didWebFromDomainPath,
  didWebToUrl,
} from './did.js';
export { type DataIntegrityProof, type ProofPurpose, signDocument, verifyDocument } from './proof.js';
export {
  CONTEXTS,
  type DtgType,
  type VerifiableCredential,
  type VerifiablePresentation,
  type BuilderCommon,
  MAX_VALIDITY_DAYS,
  ENDORSEMENT_SCOPES,
  DEFAULT_AUTHORITY_MAX_DEPTH,
  buildMembershipGrant,
  buildMembershipAck,
  buildInvitation,
  buildRelationship,
  buildEndorsement,
  buildWitness,
  buildDelegation,
  buildAuthority,
  buildPersonaLink,
  buildAdjudication,
  attenuate,
  isMembershipPairComplete,
  createPresentation,
  checkDelegationChain,
} from './credentials.js';
export { BACKUP_PBKDF2_ITERATIONS, createBackup, openBackup } from './backup.js';
export { splitSecret, combineShares } from './shamir.js';
