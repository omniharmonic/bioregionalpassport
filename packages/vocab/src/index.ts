/**
 * @passport/vocab — authority scopes, tiers, predicates.
 *
 * Dependency-free constants package used by the policy enforcement point,
 * verifier and UI. Normative source: docs/build-set/12-passport-protocol-schema-reference.md §3.
 */

/** Trust tiers, lowest to highest. */
export const TIERS = ['T0', 'T1', 'T2', 'T3', 'T4'] as const;
export type Tier = (typeof TIERS)[number];

/** Default display names for each tier (manifest `copy` can override). */
export const TIER_NAMES: Record<Tier, string> = {
  T0: 'Visitor',
  T1: 'Member',
  T2: 'Trusted',
  T3: 'Steward',
  T4: 'Anchor',
};

/**
 * Authority scope vocabulary (B3 §3). Opaque strings, exact match, additive only.
 * `defaultTier` is the tier that grants the scope by default; `owner` scopes are
 * granted to an enterprise/group owner and attenuated from there.
 */
export const AUTHORITY_SCOPES = {
  'event:attend': { meaning: 'may register for attestation events', defaultTier: 'T1' },
  'vrc:exchange': { meaning: 'may form relationships inside the pod', defaultTier: 'T1' },
  'vec:issue': { meaning: 'may endorse (unweighted)', defaultTier: 'T1' },
  'vec:issue:weighted': { meaning: 'may endorse (index-weighted)', defaultTier: 'T2' },
  'round:comment': { meaning: 'grants participation (comment)', defaultTier: 'T1' },
  'round:vote': { meaning: 'grants participation (vote)', defaultTier: 'T2' },
  'round:propose': { meaning: 'grants participation (propose)', defaultTier: 'T2' },
  'credit:account': { meaning: 'may open a ledger account', defaultTier: 'T1' },
  'credit:limit:L1': { meaning: 'credit line band L1', defaultTier: 'T1' },
  'credit:limit:L2': { meaning: 'credit line band L2', defaultTier: 'T2' },
  'credit:limit:L3': { meaning: 'credit line band L3', defaultTier: 'T3' },
  'vic:issue': { meaning: 'may invite (rate-limited)', defaultTier: 'T2' },
  'vic:issue:unlimited': { meaning: 'may invite (unlimited)', defaultTier: 'T4' },
  'group:create': { meaning: 'may mint a group VTC', defaultTier: 'T2' },
  'pay:receive': {
    meaning: 'may receive credits at the named enterprise scope',
    defaultTier: 'owner',
  },
  'event:convene': { meaning: 'may convene events', defaultTier: 'T3' },
  'vwc:issue': { meaning: 'may witness edges', defaultTier: 'T3' },
  'pep:review': { meaning: 'steward review', defaultTier: 'T3' },
  'registry:propose': { meaning: 'propose registry changes', defaultTier: 'T3' },
  'vmc:grant': { meaning: 'co-sign admissions', defaultTier: 'T4' },
  'did:witness': { meaning: 'countersign the pod DID log', defaultTier: 'T4' },
} as const satisfies Record<string, { meaning: string; defaultTier: Tier | 'owner' }>;

export type AuthorityScope = keyof typeof AUTHORITY_SCOPES;

function rank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

/** Ordinal rank of a tier (T0 = 0 .. T4 = 4). */
export function tierRank(tier: Tier): number {
  const r = rank(tier);
  if (r < 0) throw new Error(`unknown tier: ${tier}`);
  return r;
}

/** True when `tier` is at least as high as `min`. */
export function isAtLeast(tier: Tier, min: Tier): boolean {
  return tierRank(tier) >= tierRank(min);
}

/**
 * Cumulative default action set for a tier, per the MVP plan §5 Task 3 table.
 * T1: event:attend, vrc:exchange, vec:issue, round:comment, credit:account, credit:limit:L1
 * T2 adds: vec:issue:weighted, round:vote, round:propose, credit:limit:L2, vic:issue, group:create
 * T3 adds: event:convene, vwc:issue, pep:review, registry:propose, credit:limit:L3
 * T4 adds: vic:issue:unlimited, vmc:grant, did:witness
 */
const TIER_ACTIONS: Record<Tier, readonly AuthorityScope[]> = {
  T0: [],
  T1: [
    'event:attend',
    'vrc:exchange',
    'vec:issue',
    'round:comment',
    'credit:account',
    'credit:limit:L1',
  ],
  T2: [
    'vec:issue:weighted',
    'round:vote',
    'round:propose',
    'credit:limit:L2',
    'vic:issue',
    'group:create',
  ],
  T3: ['event:convene', 'vwc:issue', 'pep:review', 'registry:propose', 'credit:limit:L3'],
  T4: ['vic:issue:unlimited', 'vmc:grant', 'did:witness'],
};

/** Cumulative action set for a tier (includes every lower tier's actions). */
export function tierDefaultActions(tier: Tier): AuthorityScope[] {
  const actions: AuthorityScope[] = [];
  for (const t of TIERS) {
    actions.push(...TIER_ACTIONS[t]);
    if (t === tier) break;
  }
  return actions;
}

/** Pod-defined predicates (B3 §2), published at https://bioregion.org/vocab/v1#. */
export const PREDICATES = {
  endorses: 'dtg:endorses',
  witnessed: 'dtg:witnessed',
  adjudicated: 'bioregion:adjudicated',
} as const;

/** Endorsement (`dtg:endorses`) scope values, B3 §2. */
export const ENDORSEMENT_SCOPES = ['lives-here', 'worked-with', 'knows'] as const;
export type EndorsementScope = (typeof ENDORSEMENT_SCOPES)[number];

/** Publication URL and version of the authority scope vocabulary (B3 §3). */
export const VOCAB_URL = 'https://bioregion.org/authority/v1';
export const VOCAB_VERSION = 1;

/** A parsed `<CredentialType>:<scope>` credential requirement string. */
export interface CredentialRequirement {
  type: string;
  scope: string;
}

/**
 * Parse a credential requirement string as used in manifest `modules.thirdParty[].requires`
 * and pay-protocol `acceptance.requires` (B3 §6/§7), e.g.
 * `"AuthorityCredential:credit:account"` -> `{ type: "AuthorityCredential", scope: "credit:account" }`
 * `"MembershipCredential:pod"` -> `{ type: "MembershipCredential", scope: "pod" }`
 */
export function parseRequirement(input: string): CredentialRequirement {
  const idx = input.indexOf(':');
  if (idx <= 0 || idx === input.length - 1) {
    throw new Error(`invalid credential requirement: ${input}`);
  }
  return { type: input.slice(0, idx), scope: input.slice(idx + 1) };
}
