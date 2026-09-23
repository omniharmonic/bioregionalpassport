import { defaultTrustPolicy } from '@passport/tenant-config';
import { describe, expect, it } from 'vitest';
import { parseTierRequirement } from './requirements.js';
import { V1Scorer, computeScore, endorsementSum, hopFactor, seedDistances, spreadFactor } from './scorer.js';
import type { MemberAggregate, TrustGraph } from './types.js';

const POD = 'did:web:bioregionalpassport.org:dids:test';

function member(did: string, over: Partial<MemberAggregate> = {}): MemberAggregate {
  return {
    did,
    vmcPairComplete: true,
    recordedTier: 'T1',
    witnessedEdges: 0,
    distinctEvents: 0,
    distinctConveners: 0,
    endorsements: [],
    ...over,
  };
}

describe('score formula (FR-TR-1)', () => {
  const policy = { ...defaultTrustPolicy(POD), seedSet: ['did:key:seed'] };

  it('components match hand-computed values', () => {
    // lives-here fresh: 1.0 × 0.5^0 = 1.0; knows at one half-life: 0.5 × 0.5 = 0.25
    expect(
      endorsementSum(
        [
          { scope: 'lives-here', ageDays: 0, weighted: true },
          { scope: 'knows', ageDays: 365, weighted: false },
          { scope: 'unknown-scope', ageDays: 0, weighted: false },
        ],
        policy,
      ),
    ).toBeCloseTo(1.25, 10);
    expect(spreadFactor(2, 3)).toBeCloseTo(2 / 3, 10);
    expect(spreadFactor(0, 0)).toBe(0.5); // clipped low
    expect(spreadFactor(1, 4)).toBe(0.5); // 0.25 → 0.5
    expect(spreadFactor(3, 3)).toBe(1);
    expect(hopFactor(0, 0.6, false)).toBe(1);
    expect(hopFactor(2, 0.6, false)).toBeCloseTo(0.36, 10);
    expect(hopFactor(null, 0.6, false)).toBe(0);
    expect(hopFactor(null, 0.6, true)).toBe(1); // empty seed set disables hop decay
  });

  it('score = D × (α·W + β·E) × R', () => {
    // D = 0.6^2 = 0.36; α·W + β·E = 1×3 + 0.5×1.25 = 3.625; R = 2/3 → 0.36 × 3.625 × 2/3 = 0.87
    expect(computeScore({ witnessedEdges: 3, endorsementSum: 1.25, hopFactor: 0.36, spread: 2 / 3 }, policy)).toBeCloseTo(
      0.87,
      10,
    );
  });

  it('V1Scorer computes hops by BFS and applies the formula end to end', () => {
    const m = member('did:key:m', {
      witnessedEdges: 3,
      distinctEvents: 2,
      distinctConveners: 2,
      endorsements: [
        { scope: 'lives-here', ageDays: 0, weighted: true },
        { scope: 'knows', ageDays: 365, weighted: false },
      ],
    });
    const graph: TrustGraph = {
      members: new Map([[m.did, m]]),
      links: new Map([
        ['did:key:seed', new Set(['did:key:a'])],
        ['did:key:a', new Set(['did:key:m'])],
      ]),
    };
    const rec = new V1Scorer().compute(graph, policy).get(m.did)!;
    expect(rec.metrics.seedHops).toBe(2);
    expect(rec.score).toBeCloseTo(0.87, 10);

    const noSeeds = new V1Scorer().compute(graph, { ...policy, seedSet: [] }).get(m.did)!;
    expect(noSeeds.metrics.hopFactor).toBe(1);
    expect(noSeeds.score).toBeCloseTo(3.625 * (2 / 3), 10);

    const unreachable = new V1Scorer().compute({ ...graph, links: new Map() }, policy).get(m.did)!;
    expect(unreachable.metrics.seedHops).toBeNull();
    expect(unreachable.score).toBe(0);
  });

  it('BFS follows links in the posted direction only', () => {
    const links = new Map([
      ['did:key:seed', new Set(['did:key:a'])],
      ['did:key:b', new Set(['did:key:a'])],
    ]);
    const d = seedDistances(links, ['did:key:seed']);
    expect(d.get('did:key:seed')).toBe(0);
    expect(d.get('did:key:a')).toBe(1);
    expect(d.has('did:key:b')).toBe(false);
  });
});

describe('requirement grammar', () => {
  it('parses comparisons, units and bare flags generically', () => {
    expect(parseTierRequirement('witnessedEdges>=3')).toMatchObject({ kind: 'compare', metric: 'witnessedEdges', op: '>=', value: 3 });
    expect(parseTierRequirement('spread>=0.5')).toMatchObject({ metric: 'spread', value: 0.5 });
    expect(parseTierRequirement('seedHops<=3')).toMatchObject({ metric: 'seedHops', op: '<=', value: 3 });
    expect(parseTierRequirement('T2for>=180d')).toMatchObject({ metric: 'T2for', value: 180, unit: 'd' });
    expect(parseTierRequirement('vmcPairComplete')).toMatchObject({ kind: 'flag', metric: 'vmcPairComplete' });
    expect(parseTierRequirement('what is this?')).toMatchObject({ kind: 'invalid' });
  });

  it('governance requirements pass only from the recorded tier; unknown metrics fail closed', () => {
    const policy = defaultTrustPolicy(POD);
    const steward = member('did:key:s', { recordedTier: 'T3', witnessedEdges: 3, distinctEvents: 2 });
    const rec = new V1Scorer()
      .compute({ members: new Map([[steward.did, steward]]), links: new Map() }, policy)
      .get(steward.did)!;
    expect(rec.tier).toBe('T3');
    expect(rec.next).toMatchObject({ tier: 'T4', missing: ['namedInGovernance'] });
    expect(rec.explanation.some((s) => /never computes it/.test(s))).toBe(true);

    const odd = { ...policy, tiers: { ...policy.tiers, T1: { requires: ['vmcPairComplete', 'moonPhase>=1'] } } };
    const r2 = new V1Scorer().compute({ members: new Map([['did:key:x', member('did:key:x', { witnessedEdges: 1 })]]), links: new Map() }, odd);
    expect(r2.get('did:key:x')!.tier).toBe('T0');
  });

  it('a DID without a membership pair is always T0', () => {
    const policy = defaultTrustPolicy(POD);
    const m = member('did:key:n', { vmcPairComplete: false, recordedTier: null, witnessedEdges: 3, distinctEvents: 2 });
    const rec = new V1Scorer().compute({ members: new Map([[m.did, m]]), links: new Map() }, policy).get(m.did)!;
    expect(rec.tier).toBe('T0');
    expect(rec.next?.missing).toContain('vmcPairComplete');
  });
});
