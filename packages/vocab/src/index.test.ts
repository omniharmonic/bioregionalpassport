import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_SCOPES,
  ENDORSEMENT_SCOPES,
  PREDICATES,
  TIERS,
  TIER_NAMES,
  VOCAB_URL,
  VOCAB_VERSION,
  isAtLeast,
  parseRequirement,
  tierDefaultActions,
  tierRank,
  type AuthorityScope,
} from './index.js';

const B3_TERMS: AuthorityScope[] = [
  'event:attend',
  'vrc:exchange',
  'vec:issue',
  'vec:issue:weighted',
  'round:comment',
  'round:vote',
  'round:propose',
  'credit:account',
  'credit:limit:L1',
  'credit:limit:L2',
  'credit:limit:L3',
  'vic:issue',
  'vic:issue:unlimited',
  'group:create',
  'pay:receive',
  'event:convene',
  'vwc:issue',
  'pep:review',
  'registry:propose',
  'vmc:grant',
  'did:witness',
];

describe('AUTHORITY_SCOPES', () => {
  it('has every B3 §3 term with a meaning and default tier', () => {
    expect(Object.keys(AUTHORITY_SCOPES).sort()).toEqual([...B3_TERMS].sort());
    for (const term of B3_TERMS) {
      const entry = AUTHORITY_SCOPES[term];
      expect(entry).toBeDefined();
      expect(typeof entry.meaning).toBe('string');
      expect(entry.meaning.length).toBeGreaterThan(0);
      expect(['T1', 'T2', 'T3', 'T4', 'owner']).toContain(entry.defaultTier);
    }
  });

  it('assigns the exact default tiers from B3 §3', () => {
    expect(AUTHORITY_SCOPES['event:attend'].defaultTier).toBe('T1');
    expect(AUTHORITY_SCOPES['vrc:exchange'].defaultTier).toBe('T1');
    expect(AUTHORITY_SCOPES['vec:issue'].defaultTier).toBe('T1');
    expect(AUTHORITY_SCOPES['vec:issue:weighted'].defaultTier).toBe('T2');
    expect(AUTHORITY_SCOPES['round:comment'].defaultTier).toBe('T1');
    expect(AUTHORITY_SCOPES['round:vote'].defaultTier).toBe('T2');
    expect(AUTHORITY_SCOPES['round:propose'].defaultTier).toBe('T2');
    expect(AUTHORITY_SCOPES['credit:account'].defaultTier).toBe('T1');
    expect(AUTHORITY_SCOPES['credit:limit:L1'].defaultTier).toBe('T1');
    expect(AUTHORITY_SCOPES['credit:limit:L2'].defaultTier).toBe('T2');
    expect(AUTHORITY_SCOPES['credit:limit:L3'].defaultTier).toBe('T3');
    expect(AUTHORITY_SCOPES['vic:issue'].defaultTier).toBe('T2');
    expect(AUTHORITY_SCOPES['vic:issue:unlimited'].defaultTier).toBe('T4');
    expect(AUTHORITY_SCOPES['group:create'].defaultTier).toBe('T2');
    expect(AUTHORITY_SCOPES['pay:receive'].defaultTier).toBe('owner');
    expect(AUTHORITY_SCOPES['event:convene'].defaultTier).toBe('T3');
    expect(AUTHORITY_SCOPES['vwc:issue'].defaultTier).toBe('T3');
    expect(AUTHORITY_SCOPES['pep:review'].defaultTier).toBe('T3');
    expect(AUTHORITY_SCOPES['registry:propose'].defaultTier).toBe('T3');
    expect(AUTHORITY_SCOPES['vmc:grant'].defaultTier).toBe('T4');
    expect(AUTHORITY_SCOPES['did:witness'].defaultTier).toBe('T4');
  });
});

describe('TIERS / TIER_NAMES', () => {
  it('lists T0..T4 in order', () => {
    expect(TIERS).toEqual(['T0', 'T1', 'T2', 'T3', 'T4']);
  });

  it('has a display name for every tier', () => {
    for (const tier of TIERS) {
      expect(typeof TIER_NAMES[tier]).toBe('string');
      expect(TIER_NAMES[tier].length).toBeGreaterThan(0);
    }
    expect(TIER_NAMES.T1).toBe('Member');
    expect(TIER_NAMES.T4).toBe('Anchor');
  });
});

describe('tierRank / isAtLeast', () => {
  it('ranks tiers in ascending order', () => {
    expect(tierRank('T0')).toBe(0);
    expect(tierRank('T4')).toBe(4);
    expect(tierRank('T2')).toBeGreaterThan(tierRank('T1'));
  });

  it('isAtLeast compares tier rank', () => {
    expect(isAtLeast('T2', 'T1')).toBe(true);
    expect(isAtLeast('T1', 'T1')).toBe(true);
    expect(isAtLeast('T1', 'T2')).toBe(false);
  });
});

describe('tierDefaultActions', () => {
  it('is cumulative: T4 ⊇ T3 ⊇ T2 ⊇ T1', () => {
    const t1 = new Set(tierDefaultActions('T1'));
    const t2 = new Set(tierDefaultActions('T2'));
    const t3 = new Set(tierDefaultActions('T3'));
    const t4 = new Set(tierDefaultActions('T4'));

    for (const a of t1) expect(t2.has(a)).toBe(true);
    for (const a of t2) expect(t3.has(a)).toBe(true);
    for (const a of t3) expect(t4.has(a)).toBe(true);

    expect(t1.size).toBeLessThan(t2.size);
    expect(t2.size).toBeLessThan(t3.size);
    expect(t3.size).toBeLessThan(t4.size);
  });

  it('T0 has no default actions', () => {
    expect(tierDefaultActions('T0')).toEqual([]);
  });

  it('T1 has exactly the plan-specified actions', () => {
    expect(new Set(tierDefaultActions('T1'))).toEqual(
      new Set([
        'event:attend',
        'vrc:exchange',
        'vec:issue',
        'round:comment',
        'credit:account',
        'credit:limit:L1',
      ]),
    );
  });

  it('T2 adds the plan-specified actions on top of T1', () => {
    const added = [
      'vec:issue:weighted',
      'round:vote',
      'round:propose',
      'credit:limit:L2',
      'vic:issue',
      'group:create',
    ];
    const t2 = new Set(tierDefaultActions('T2'));
    for (const a of added) expect(t2.has(a as AuthorityScope)).toBe(true);
  });

  it('T3 adds the plan-specified actions on top of T2', () => {
    const added = ['event:convene', 'vwc:issue', 'pep:review', 'registry:propose', 'credit:limit:L3'];
    const t3 = new Set(tierDefaultActions('T3'));
    for (const a of added) expect(t3.has(a as AuthorityScope)).toBe(true);
  });

  it('T4 adds the plan-specified actions on top of T3', () => {
    const added = ['vic:issue:unlimited', 'vmc:grant', 'did:witness'];
    const t4 = new Set(tierDefaultActions('T4'));
    for (const a of added) expect(t4.has(a as AuthorityScope)).toBe(true);
  });
});

describe('PREDICATES / ENDORSEMENT_SCOPES', () => {
  it('has the three B3 predicates', () => {
    expect(PREDICATES).toEqual({
      endorses: 'dtg:endorses',
      witnessed: 'dtg:witnessed',
      adjudicated: 'bioregion:adjudicated',
    });
  });

  it('has the three endorsement scopes', () => {
    expect(ENDORSEMENT_SCOPES).toEqual(['lives-here', 'worked-with', 'knows']);
  });
});

describe('VOCAB_URL / VOCAB_VERSION', () => {
  it('matches B3 §3', () => {
    expect(VOCAB_URL).toBe('https://bioregion.org/authority/v1');
    expect(VOCAB_VERSION).toBe(1);
  });
});

describe('parseRequirement', () => {
  it('parses an AuthorityCredential requirement with a compound scope', () => {
    expect(parseRequirement('AuthorityCredential:credit:account')).toEqual({
      type: 'AuthorityCredential',
      scope: 'credit:account',
    });
  });

  it('parses a MembershipCredential requirement', () => {
    expect(parseRequirement('MembershipCredential:pod')).toEqual({
      type: 'MembershipCredential',
      scope: 'pod',
    });
  });

  it('throws on a malformed requirement', () => {
    expect(() => parseRequirement('nocolon')).toThrow();
    expect(() => parseRequirement(':scope')).toThrow();
    expect(() => parseRequirement('Type:')).toThrow();
  });
});
