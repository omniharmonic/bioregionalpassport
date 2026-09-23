import { describe, expect, it } from 'vitest';
import {
  ManifestSchema,
  ManifestSchemaJson,
  TrustPolicySchema,
  boulderManifest,
  tenantZeroManifest,
  copy,
  DEFAULT_COPY,
  defaultTrustPolicy,
  manifestHash,
  manifestUrl,
  validateManifest,
  validateTrustPolicy,
} from './index.js';

describe('ManifestSchema', () => {
  it('validates the Boulder manifest', () => {
    const result = validateManifest(boulderManifest);
    expect(result.ok).toBe(true);
  });

  it('validates the tenant-zero manifest', () => {
    const result = validateManifest(tenantZeroManifest);
    expect(result.ok).toBe(true);
  });

  it('turns on every demo module for tenant-zero, including Merchant Mode', () => {
    expect(tenantZeroManifest.modules).toMatchObject({ map: true, grants: true, circulation: true, merchant: true });
  });

  it('parses both manifests directly with ManifestSchema', () => {
    expect(() => ManifestSchema.parse(boulderManifest)).not.toThrow();
    expect(() => ManifestSchema.parse(tenantZeroManifest)).not.toThrow();
  });

  it('rejects a manifest whose $schema major version is newer than supported', () => {
    const bad = {
      ...boulderManifest,
      $schema: 'https://bioregion.org/schemas/manifest/v2',
    };
    const result = validateManifest(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.includes('manifest schema major version 2 is newer than supported 1'))
      ).toBe(true);
      // should not also fire a generic "must start with" error for a well-formed v2 URL
      expect(result.errors.some((e) => e.includes('must start with'))).toBe(false);
    }
  });

  it('rejects a $schema that does not match the expected prefix at all', () => {
    const bad = { ...boulderManifest, $schema: 'https://example.com/schemas/manifest/v1' };
    const result = validateManifest(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('must start with'))).toBe(true);
    }
  });

  it('produces path-qualified errors when required sections are missing', () => {
    const { identity, ...rest } = boulderManifest as any;
    const result = validateManifest(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('identity'))).toBe(true);
    }
  });

  it('produces path-qualified errors for missing nested fields', () => {
    const broken = { ...boulderManifest, theme: { ...boulderManifest.theme, tokens: undefined } } as any;
    delete broken.theme.tokens;
    const result = validateManifest(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('theme.tokens'))).toBe(true);
    }
  });

  it('exposes a JSON Schema for the operator console editor', () => {
    expect(ManifestSchemaJson).toBeTypeOf('object');
    expect(ManifestSchemaJson).toHaveProperty('properties');
  });
});

describe('TrustPolicySchema / defaultTrustPolicy', () => {
  it('matches the B3 §4 example values exactly (with an empty seed set)', () => {
    const policy = defaultTrustPolicy('did:web:bioregionalpassport.org:dids:boulder');
    expect(policy).toEqual({
      type: 'org.bioregion.trust.policy',
      pod: 'did:web:bioregionalpassport.org:dids:boulder',
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
            'distinctEventsOrWitnesses>=2',
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
      admission: { witnessTier: 'T2', peerWitnessing: true },
      anomaly: {
        endorsementVelocityPerDay: 5,
        sharedWitnessOnlyFlag: true,
        witnessPairsPerWeek: 20,
        hubMinAdmits: 5,
      },
    });
  });

  it('accepts a version-1 policy without admission or the witness anomaly fields, filling defaults', () => {
    const policy = defaultTrustPolicy('did:web:example.org:dids:x') as any;
    delete policy.admission;
    delete policy.anomaly.witnessPairsPerWeek;
    delete policy.anomaly.hubMinAdmits;
    const result = validateTrustPolicy(policy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.admission).toBeUndefined();
      expect(result.policy.anomaly.witnessPairsPerWeek).toBe(20);
      expect(result.policy.anomaly.hubMinAdmits).toBe(5);
    }
  });

  it('fills admission defaults and validates the witness tier and vouch-only settings', () => {
    const base = defaultTrustPolicy('did:web:example.org:dids:x');
    const ok = validateTrustPolicy({ ...base, admission: { vouchOnly: {} } });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.policy.admission).toEqual({ peerWitnessing: true, vouchOnly: { enabled: false, endorsements: 3 } });
    }
    const badTier = validateTrustPolicy({ ...base, admission: { witnessTier: 'T5' } });
    expect(badTier.ok).toBe(false);
    if (!badTier.ok) expect(badTier.errors.some((e) => e.startsWith('admission.witnessTier'))).toBe(true);
    const badCount = validateTrustPolicy({ ...base, admission: { vouchOnly: { enabled: true, endorsements: 0 } } });
    expect(badCount.ok).toBe(false);
  });

  it('validates via TrustPolicySchema / validateTrustPolicy', () => {
    const policy = defaultTrustPolicy('did:web:bioregionalpassport.org:dids:tenant-zero');
    expect(() => TrustPolicySchema.parse(policy)).not.toThrow();
    const result = validateTrustPolicy(policy);
    expect(result.ok).toBe(true);
  });

  it('rejects an invalid trust policy with path-qualified errors', () => {
    const policy = defaultTrustPolicy('did:web:example.org:dids:x');
    const { weights, ...rest } = policy as any;
    const result = validateTrustPolicy(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('weights'))).toBe(true);
    }
  });
});

describe('copy()', () => {
  it('returns the manifest override when present', () => {
    expect(copy(boulderManifest, 'cta.findEvent')).toBe('Find a gathering');
    expect(copy(boulderManifest, 'tier.T2.name')).toBe('Trusted neighbor');
  });

  it('falls back to DEFAULT_COPY when no override exists', () => {
    expect(copy(boulderManifest, 'cta.vouch')).toBe(DEFAULT_COPY['cta.vouch']);
    expect(copy(tenantZeroManifest, 'cta.findEvent')).toBe('Find an attestation event');
  });

  it('falls back to the raw key when neither override nor default exists', () => {
    expect(copy(boulderManifest, 'nonexistent.key')).toBe('nonexistent.key');
  });

  it('respects the locale parameter', () => {
    const manifest = {
      ...boulderManifest,
      copy: { en: { 'cta.findEvent': 'Find a gathering' }, es: { 'cta.findEvent': 'Encuentra una reunión' } },
    };
    expect(copy(manifest, 'cta.findEvent', 'es')).toBe('Encuentra una reunión');
    expect(copy(manifest, 'cta.findEvent', 'fr')).toBe(DEFAULT_COPY['cta.findEvent']);
  });
});

describe('manifestUrl', () => {
  it('builds the well-known manifest URL', () => {
    expect(manifestUrl('boulder', 'bioregionalpassport.org')).toBe(
      'https://boulder.bioregionalpassport.org/.well-known/bioregion.json'
    );
  });
});

function reverseKeyOrder<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => reverseKeyOrder(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = reverseKeyOrder(v);
    return out as T;
  }
  return value;
}

describe('manifestHash', () => {
  it('is stable across key order', () => {
    const a = manifestHash(boulderManifest);
    const reordered = reverseKeyOrder(boulderManifest);
    const b = manifestHash(reordered);
    expect(a).toBe(b);
  });

  it('ignores the proof field', () => {
    const withProof = {
      ...boulderManifest,
      proof: {
        type: 'DataIntegrityProof' as const,
        cryptosuite: 'eddsa-jcs-2022' as const,
        verificationMethod: 'did:web:bioregionalpassport.org:dids:boulder#key-1',
        proofValue: 'zSomeSignatureValue',
      },
    };
    expect(manifestHash(withProof)).toBe(manifestHash(boulderManifest));
  });

  it('produces a 64-character hex sha256 digest', () => {
    const hash = manifestHash(boulderManifest);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different manifests', () => {
    expect(manifestHash(boulderManifest)).not.toBe(manifestHash(tenantZeroManifest));
  });
});
