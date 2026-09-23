import { describe, expect, it } from 'vitest';
import { ballotsHash, ROUND_WEIGHTS, tally, voiceCost, type PublishedBallot } from './tally.js';

const proof = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: '2026-09-22T00:00:00Z', verificationMethod: 'x', proofPurpose: 'assertionMethod', proofValue: 'z1' } as const;
const b = (voterKey: string, allocations: Record<string, number>, tier = 'T2'): PublishedBallot => ({
  round: 'r1',
  voterKey,
  issuer: voterKey,
  allocations,
  createdAt: '2026-09-22T00:00:00Z',
  nonce: `nonce-${voterKey}`,
  proof: { ...proof },
  tier,
});
const ballots = [b('did:key:z1', { A: 4 }), b('did:key:z2', { A: 1, B: 1 }), b('did:key:z3', { B: 9 }, 'T3')];

describe('voiceCost', () => {
  it('is the sum of squared votes', () => {
    expect(voiceCost({ a: 3, b: 4 })).toBe(25);
    expect(voiceCost({})).toBe(0);
  });
});

describe('tally', () => {
  it('computes QF sums, shares and matching with the remainder to the top proposal', () => {
    const t = tally(ballots, ['A', 'B'], ROUND_WEIGHTS, 100, { computedAt: '2026-09-30T00:00:00.000Z' });
    const [a, bb] = t.proposals;
    expect(a).toMatchObject({ id: 'A', rawVotes: 5, voters: 2, voiceSum: 3, qf: 9, matching: 29.84, adjustment: 0 });
    expect(bb).toMatchObject({ id: 'B', rawVotes: 10, voters: 2, voiceSum: 4.6, qf: 21.16, matching: 70.16 });
    expect(a!.share + bb!.share).toBeCloseTo(1, 5);
    expect(t.totalMatching).toBe(100);
    expect(t.unallocated).toBe(0);
    expect(t.ballotCount).toBe(3);
  });

  it('is independent of ballot order', () => {
    const x = tally(ballots, ['A', 'B'], ROUND_WEIGHTS, 100);
    const y = tally([...ballots].reverse(), ['B', 'A'], ROUND_WEIGHTS, 100);
    expect(y).toEqual(x);
  });

  it('caps matching and re-splits the excess; leaves what cannot be placed unallocated', () => {
    const t60 = tally(ballots, ['A', 'B'], ROUND_WEIGHTS, 100, { matchingCap: 60 });
    expect(t60.proposals.map((p) => p.matching)).toEqual([40, 60]);
    const t30 = tally(ballots, ['A', 'B'], ROUND_WEIGHTS, 100, { matchingCap: 30 });
    expect(t30.proposals.map((p) => p.matching)).toEqual([30, 30]);
    expect(t30.unallocated).toBe(40);
  });

  it('gives the rounding remainder to the next proposal with room when the top one is at the cap', () => {
    const bs = [b('did:key:y1', { B: 80 }), b('did:key:y2', { C: 41 }), b('did:key:y3', { D: 41 })];
    const t = tally(bs, ['B', 'C', 'D'], ROUND_WEIGHTS, 0.81, { matchingCap: 0.4 });
    expect(t.proposals.map((p) => p.matching)).toEqual([0.4, 0.21, 0.2]);
    expect(t.totalMatching).toBe(0.81);
    expect(t.unallocated).toBe(0);
  });

  it('carries the plan shape aliases: votes and verifiable.ballotsHash', () => {
    const t = tally(ballots, ['A', 'B'], ROUND_WEIGHTS, 100);
    expect(t.proposals.map((p) => p.votes)).toEqual(t.proposals.map((p) => p.rawVotes));
    expect(t.verifiable).toEqual({ ballotsHash: t.ballotsHash });
  });

  it('applies and lists adjustments', () => {
    const adj = { proposalId: 'A', delta: -10, reason: 'Sybil cluster', stewardDid: 'did:key:zS', createdAt: '2026-09-30T00:00:00.000Z' };
    const t = tally(ballots, ['A', 'B'], ROUND_WEIGHTS, 100, { adjustments: [adj] });
    expect(t.proposals[0]).toMatchObject({ matching: 19.84, adjustment: -10 });
    expect(t.totalMatching).toBe(90);
    expect(t.adjustments).toEqual([adj]);
  });

  it('with no votes places nothing', () => {
    const t = tally([], ['A'], ROUND_WEIGHTS, 50);
    expect(t.proposals[0]!.matching).toBe(0);
    expect(t.unallocated).toBe(50);
  });

  it('refuses ballots for unknown proposals', () => {
    expect(() => tally([b('did:key:z9', { C: 1 })], ['A'], ROUND_WEIGHTS, 10)).toThrow(/unknown proposal/);
  });

  it('ballotsHash changes when any ballot is altered', () => {
    const h = ballotsHash(ballots);
    expect(ballotsHash([...ballots].reverse())).toBe(h);
    const altered = ballots.map((x, i) => (i === 1 ? { ...x, allocations: { A: 1, B: 2 } } : x));
    expect(ballotsHash(altered)).not.toBe(h);
  });
});
