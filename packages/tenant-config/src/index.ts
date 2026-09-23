import { z } from 'zod';
import canonicalize from 'canonicalize';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const HexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{3,8}$/, 'must be a hex colour');

const SCHEMA_PREFIX = 'https://bioregion.org/schemas/manifest/';

const SchemaVersionString = z.string().superRefine((v, ctx) => {
  const match = v.startsWith(SCHEMA_PREFIX) ? v.slice(SCHEMA_PREFIX.length).match(/^v(\d+)/) : null;
  if (!match) {
    ctx.addIssue({
      code: 'custom',
      message: `manifest $schema must start with ${SCHEMA_PREFIX}v1`,
    });
    return;
  }
  const major = Number(match[1]);
  if (major > 1) {
    ctx.addIssue({
      code: 'custom',
      message: `manifest schema major version ${major} is newer than supported 1`,
    });
  }
});

const DataIntegrityProofSchema = z.object({
  type: z.literal('DataIntegrityProof'),
  cryptosuite: z.literal('eddsa-jcs-2022'),
  created: z.string().optional(),
  verificationMethod: z.string(),
  proofPurpose: z.string().optional(),
  proofValue: z.string(),
});

export type DataIntegrityProof = z.infer<typeof DataIntegrityProofSchema>;

// ---------------------------------------------------------------------------
// ManifestSchema (B3 §7)
// ---------------------------------------------------------------------------

const IdentitySchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,40}$/, 'slug must match /^[a-z0-9-]{2,40}$/'),
  name: z.string(),
  did: z.string(),
  handleDomain: z.string(),
  contact: z.string(),
});

const ThemeSchema = z.object({
  tokens: z.object({
    primary: HexColor,
    accent: HexColor,
    bg: HexColor,
    fg: HexColor,
  }),
  font: z.object({
    display: z.string(),
    body: z.string(),
  }),
  logo: z.string().optional(),
  icon: z.string().optional(),
  splash: z.string().optional(),
  tone: z.enum(['warm', 'civic', 'plain']),
});

const CopySchema = z.record(z.string(), z.record(z.string(), z.string()));

const WatershedSourceSchema = z.object({
  type: z.enum(['twin', 'static']),
  endpoint: z.string().optional(),
  hucs: z.array(z.string()).optional(),
});

const LonLat = z.tuple([z.number(), z.number()]);

const PlaceSchema = z.object({
  bioregionPolygon: z.string().optional(),
  watershedSource: WatershedSourceSchema,
  bounds: z.tuple([LonLat, LonLat]),
  defaultZoom: z.number(),
});

const ThirdPartyModuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  deepLink: z.string(),
  requires: z.array(z.string()),
  icon: z.string().optional(),
});

const ModulesSchema = z.object({
  map: z.boolean(),
  grants: z.boolean(),
  circulation: z.boolean(),
  merchant: z.boolean(),
  thirdParty: z.array(ThirdPartyModuleSchema),
});

const CurrencySchema = z.object({
  unit: z.string(),
  parity: z.string(),
  limits: z.object({
    L1: z.number(),
    L2: z.number(),
    L3: z.number(),
  }),
  defaultAcceptance: z.object({
    services: z.number(),
    suppliers: z.number(),
    retail: z.number(),
  }),
  offlineAllowancePerDay: z.number(),
  node: z.string(),
});

const ServicesSchema = z.object({
  vta: z.string(),
  index: z.string(),
  round: z.string(),
  appview: z.string(),
  mediator: z.string(),
  registry: z.string(),
});

const GovernanceSchema = z.object({
  url: z.string(),
  disclosure: z.string(),
  anchors: z.array(z.string()),
  disputes: z.string(),
});

const BuildSchema = z.object({
  iosBundleId: z.string().optional(),
  androidPackage: z.string().optional(),
  scheme: z.string().optional(),
});

export const ManifestSchema = z.object({
  $schema: SchemaVersionString,
  identity: IdentitySchema,
  theme: ThemeSchema,
  copy: CopySchema,
  place: PlaceSchema,
  modules: ModulesSchema,
  trustPolicy: z.string(),
  currency: CurrencySchema,
  services: ServicesSchema,
  governance: GovernanceSchema,
  build: BuildSchema.optional(),
  proof: DataIntegrityProofSchema.optional(),
});

export type BioregionManifest = z.infer<typeof ManifestSchema>;

export const ManifestSchemaJson = z.toJSONSchema(ManifestSchema);

// ---------------------------------------------------------------------------
// TrustPolicySchema (B3 §4)
// ---------------------------------------------------------------------------

const TierRequirementSchema = z.object({
  requires: z.array(z.string()),
});

export const TrustPolicySchema = z.object({
  type: z.literal('org.bioregion.trust.policy'),
  pod: z.string(),
  version: z.number(),
  weights: z.object({
    alpha: z.number(),
    beta: z.number(),
    hopDecay: z.number(),
    endorsementHalfLifeDays: z.number(),
    scopeWeights: z.record(z.string(), z.number()),
  }),
  seedSet: z.array(z.string()),
  seedRotationMonths: z.number(),
  tiers: z.object({
    T1: TierRequirementSchema,
    T2: TierRequirementSchema,
    T3: TierRequirementSchema,
    T4: TierRequirementSchema,
  }),
  vacValidityDays: z.number(),
  grantValidityDays: z.number(),
  vicRatePerMonth: z.record(z.string(), z.number()),
  idvcRequired: z.boolean(),
  downgradeAtExpiryOnly: z.boolean(),
  anomaly: z.object({
    endorsementVelocityPerDay: z.number(),
    sharedWitnessOnlyFlag: z.boolean(),
  }),
  proof: DataIntegrityProofSchema.optional(),
});

export type TrustPolicy = z.infer<typeof TrustPolicySchema>;

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function formatZodErrors(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

export function validateManifest(
  input: unknown
): { ok: true; manifest: BioregionManifest } | { ok: false; errors: string[] } {
  const result = ManifestSchema.safeParse(input);
  if (result.success) {
    return { ok: true, manifest: result.data };
  }
  return { ok: false, errors: formatZodErrors(result.error) };
}

export function validateTrustPolicy(
  input: unknown
): { ok: true; policy: TrustPolicy } | { ok: false; errors: string[] } {
  const result = TrustPolicySchema.safeParse(input);
  if (result.success) {
    return { ok: true, policy: result.data };
  }
  return { ok: false, errors: formatZodErrors(result.error) };
}

// ---------------------------------------------------------------------------
// defaultTrustPolicy (B3 §4 example values)
// ---------------------------------------------------------------------------

export function defaultTrustPolicy(podDid: string): TrustPolicy {
  return {
    type: 'org.bioregion.trust.policy',
    pod: podDid,
    version: 1,
    weights: {
      alpha: 1.0,
      beta: 0.5,
      hopDecay: 0.6,
      endorsementHalfLifeDays: 365,
      scopeWeights: { 'lives-here': 1.0, 'worked-with': 0.8, knows: 0.5 },
    },
    seedSet: [],
    seedRotationMonths: 12,
    tiers: {
      T1: { requires: ['vmcPairComplete', 'witnessedEdges>=1'] },
      T2: {
        requires: [
          'witnessedEdges>=3',
          'distinctEvents>=2',
          'weightedEndorsements>=2',
          'seedHops<=3',
          'spread>=0.5',
        ],
      },
      T3: { requires: ['electedByGovernance', 'T2for>=180d'] },
      T4: { requires: ['namedInGovernance'] },
    },
    vacValidityDays: 90,
    grantValidityDays: 90,
    vicRatePerMonth: { T2: 3 },
    idvcRequired: false,
    downgradeAtExpiryOnly: true,
    anomaly: { endorsementVelocityPerDay: 5, sharedWitnessOnlyFlag: true },
  };
}

// ---------------------------------------------------------------------------
// Copy / DEFAULT_COPY
// ---------------------------------------------------------------------------

export const DEFAULT_COPY: Record<string, string> = {
  'cta.findEvent': 'Find an attestation event',
  'cta.vouch': 'Vouch for a neighbor',
  'cta.pay': 'Pay with credits',
  'cta.earn': 'What can you offer?',
  'tier.T0.name': 'Visitor',
  'tier.T1.name': 'Member',
  'tier.T2.name': 'Trusted',
  'tier.T3.name': 'Steward',
  'tier.T4.name': 'Anchor',
  'module.map': 'Map',
  'module.grants': 'Grants',
  'module.circulation': 'Credits',
  'module.merchant': 'Merchant mode',
};

export function copy(manifest: BioregionManifest, key: string, locale = 'en'): string {
  const override = manifest.copy?.[locale]?.[key];
  if (override !== undefined) return override;
  const fallback = DEFAULT_COPY[key];
  if (fallback !== undefined) return fallback;
  return key;
}

// ---------------------------------------------------------------------------
// manifestUrl / manifestHash
// ---------------------------------------------------------------------------

export function manifestUrl(slug: string, platformDomain: string): string {
  return `https://${slug}.${platformDomain}/.well-known/bioregion.json`;
}

export function manifestHash(manifest: BioregionManifest): string {
  const { proof: _proof, ...withoutProof } = manifest;
  const canonical = canonicalize(withoutProof);
  if (canonical === undefined) {
    throw new Error('manifestHash: manifest could not be canonicalized');
  }
  const digest = sha256(utf8ToBytes(canonical));
  return bytesToHex(digest);
}

// ---------------------------------------------------------------------------
// Boulder manifest
// ---------------------------------------------------------------------------

const PLATFORM_DOMAIN = 'bioregionalpassport.org';

function servicesFor(slug: string): z.infer<typeof ServicesSchema> {
  return {
    vta: `https://${slug}.${PLATFORM_DOMAIN}/api/vta`,
    index: `https://${slug}.${PLATFORM_DOMAIN}/api/index`,
    round: `https://${slug}.${PLATFORM_DOMAIN}/api/round`,
    appview: `https://${slug}.${PLATFORM_DOMAIN}/api/appview`,
    mediator: `https://${PLATFORM_DOMAIN}/api/relay`,
    registry: `https://${PLATFORM_DOMAIN}/api/registry`,
  };
}

function governanceFor(slug: string): z.infer<typeof GovernanceSchema> {
  return {
    url: `https://${slug}.${PLATFORM_DOMAIN}/governance`,
    disclosure: 'Member identifiers are never disclosed beyond the pod VTA.',
    anchors: [],
    disputes: `stewards@${PLATFORM_DOMAIN}`,
  };
}

export const boulderManifest: BioregionManifest = {
  $schema: 'https://bioregion.org/schemas/manifest/v1',
  identity: {
    slug: 'boulder',
    name: 'Boulder Commons',
    did: `did:web:${PLATFORM_DOMAIN}:dids:boulder`,
    handleDomain: `boulder.${PLATFORM_DOMAIN}`,
    contact: `stewards@${PLATFORM_DOMAIN}`,
  },
  theme: {
    tokens: { primary: '#1F5F4A', accent: '#E4B04A', bg: '#FBF8F2', fg: '#17201C' },
    font: { display: 'Fraunces', body: 'Inter' },
    tone: 'warm',
  },
  copy: {
    en: {
      'cta.findEvent': 'Find a gathering',
      'tier.T2.name': 'Trusted neighbor',
    },
  },
  place: {
    bioregionPolygon: 'twin:bioregion/south-platte-headwaters',
    watershedSource: { type: 'twin', endpoint: 'https://mcp.bioregionaltwin.org/mcp' },
    bounds: [
      [-105.7, 39.9],
      [-105.1, 40.2],
    ],
    defaultZoom: 11,
  },
  modules: {
    map: true,
    grants: true,
    circulation: true,
    merchant: true,
    thirdParty: [
      {
        id: 'free-school',
        name: 'Free School',
        deepLink: 'freeschool://',
        requires: ['MembershipCredential:pod'],
      },
    ],
  },
  trustPolicy: `https://boulder.${PLATFORM_DOMAIN}/api/vta/policy`,
  currency: {
    unit: 'credit',
    parity: 'USD (informal)',
    limits: { L1: 100, L2: 400, L3: 1000 },
    defaultAcceptance: { services: 0.75, suppliers: 0.35, retail: 0.2 },
    offlineAllowancePerDay: 50,
    node: `https://boulder.${PLATFORM_DOMAIN}/api/gateway`,
  },
  services: servicesFor('boulder'),
  governance: governanceFor('boulder'),
};

// ---------------------------------------------------------------------------
// Tenant zero manifest
// ---------------------------------------------------------------------------

export const tenantZeroManifest: BioregionManifest = {
  $schema: 'https://bioregion.org/schemas/manifest/v1',
  identity: {
    slug: 'tenant-zero',
    name: 'Tenant Zero',
    did: `did:web:${PLATFORM_DOMAIN}:dids:tenant-zero`,
    handleDomain: `tenant-zero.${PLATFORM_DOMAIN}`,
    contact: `stewards@${PLATFORM_DOMAIN}`,
  },
  theme: {
    tokens: { primary: '#3B4A6B', accent: '#D98E4A', bg: '#F6F7FB', fg: '#141826' },
    font: { display: 'Space Grotesk', body: 'Inter' },
    tone: 'plain',
  },
  copy: {},
  place: {
    watershedSource: { type: 'static', hucs: ['101900050301'] },
    bounds: [
      [-105.3, 40.1],
      [-104.9, 40.4],
    ],
    defaultZoom: 10,
  },
  modules: {
    map: true,
    grants: true,
    circulation: true,
    merchant: false,
    thirdParty: [],
  },
  trustPolicy: `https://tenant-zero.${PLATFORM_DOMAIN}/api/vta/policy`,
  currency: {
    unit: 'credit',
    parity: 'USD (informal)',
    limits: { L1: 100, L2: 400, L3: 1000 },
    defaultAcceptance: { services: 0.75, suppliers: 0.35, retail: 0.2 },
    offlineAllowancePerDay: 50,
    node: `https://tenant-zero.${PLATFORM_DOMAIN}/api/gateway`,
  },
  services: servicesFor('tenant-zero'),
  governance: governanceFor('tenant-zero'),
};
