export interface AnomalyFlag {
  did: string;
  kind: 'endorsement-velocity' | 'shared-witness-only';
  detail: string;
  since: string;
}

export interface StewardMember {
  did: string;
  tier: string;
  governanceTier: string;
  effectiveUntil: string | null;
  status: string;
  validUntil: string | null;
  expired: boolean;
  joinedAt: string | null;
}

export interface EventView {
  id: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  placeId: string | null;
  conveners: string[];
  attestation: boolean;
  taskDigest: string | null;
}

export interface VacLogEntry {
  id: string;
  subject: string;
  actions: unknown;
  tier: string;
  policyVersion: number | null;
  explanation: unknown;
  issuedAt: string | null;
  validUntil: string | null;
  revokedAt: string | null;
  credential: unknown;
}

export interface Dispute {
  id: string;
  subjectDigest: string | null;
  filedBy: string | null;
  reason: string | null;
  status: string;
  adjudication: unknown;
  createdAt: string | null;
}

export interface GovernanceLogEntry {
  id: string;
  subject: string;
  previousTier: string | null;
  newTier: string;
  by: string;
  reason: string;
  createdAt: string | null;
}
