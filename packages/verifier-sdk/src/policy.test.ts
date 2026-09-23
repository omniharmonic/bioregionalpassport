import { describe, expect, it } from 'vitest';
import { policyFromRequirements } from './index.js';

const POD = 'did:web:bioregionalpassport.org:dids:boulder';

describe('policyFromRequirements', () => {
  it('maps pay acceptance requirements', () => {
    expect(policyFromRequirements(['MembershipCredential:pod', 'AuthorityCredential:credit:account'], POD)).toEqual({
      acceptedPods: [POD],
      requireMembership: true,
      requireAuthority: ['credit:account'],
    });
  });

  it('does not require membership unless asked, and dedupes scopes', () => {
    expect(policyFromRequirements(['AuthorityCredential:round:vote', 'AuthorityCredential:round:vote'], POD, { allowDelegation: true })).toEqual({
      acceptedPods: [POD],
      requireMembership: false,
      requireAuthority: ['round:vote'],
      allowDelegation: true,
    });
  });

  it('supports enterprise-scoped requirements and refuses bare pay:receive', () => {
    const shop = 'did:web:bioregionalpassport.org:dids:moxie-bread';
    expect(policyFromRequirements([`AuthorityCredential:pay:receive@${shop}`], POD).requireAuthority).toEqual([`pay:receive@${shop}`]);
    expect(() => policyFromRequirements(['AuthorityCredential:pay:receive'], POD)).toThrow(/enterprise/);
    expect(() => policyFromRequirements(['AuthorityCredential:pay:receive@nobody'], POD)).toThrow(/Invalid scoped/);
  });

  it('rejects unknown types and scopes', () => {
    expect(() => policyFromRequirements(['AuthorityCredential:launch:rockets'], POD)).toThrow(/Unknown authority scope/);
    expect(() => policyFromRequirements(['PassportCredential:pod'], POD)).toThrow(/Unsupported/);
    expect(() => policyFromRequirements(['MembershipCredential'], POD)).toThrow();
  });
});
