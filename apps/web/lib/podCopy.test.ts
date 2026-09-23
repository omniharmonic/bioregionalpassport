import { describe, expect, it } from 'vitest';
import { boulderManifest, defaultTrustPolicy } from '@passport/tenant-config';
import { describeRule, describeTierRule, describeWitnessing, effectiveTierRule } from './podCopy';

const m = boulderManifest;

describe('requirement copy', () => {
  it('describes the witness-spread requirements in plain sentences', () => {
    expect(describeRule(m, 'distinctWitnesses>=2')).toBe('Your relationships were witnessed by 2 or more different neighbors.');
    expect(describeRule(m, 'distinctEventsOrWitnesses>=2')).toBe(
      'Your relationships were witnessed at 2 or more gatherings or by 2 different neighbors.',
    );
    expect(describeRule(m, 'distinctEvents>=3')).toBe('Your relationships were witnessed at 3 or more different gatherings.');
  });

  it('shows T2 distinctEvents as the trust index evaluates it under peer witnessing', () => {
    const on = { admission: { peerWitnessing: true } };
    const off = { admission: { peerWitnessing: false } };
    expect(effectiveTierRule({}, 'T2', 'distinctEvents>=2')).toBe('distinctEventsOrWitnesses>=2');
    expect(effectiveTierRule(on, 'T3', 'distinctEvents>=2')).toBe('distinctEvents>=2');
    expect(describeTierRule(m, off, 'T2', 'distinctEvents>=2')).toBe('Your relationships were witnessed at 2 or more different gatherings.');
    expect(describeTierRule(m, on, 'T2', 'distinctEvents>=2')).toContain('by 2 different neighbors');
  });

  it('says who may witness when the policy sets a witness tier', () => {
    const policy = defaultTrustPolicy(m.identity.did);
    expect(describeWitnessing(m, policy)).toMatch(/standing or above can witness/);
    expect(describeWitnessing(m, { admission: undefined })).toBeNull();
    expect(describeWitnessing(m, { admission: { witnessTier: 'T2', peerWitnessing: false } })).toBeNull();
  });
});
