import { describe, expect, it } from 'vitest';
import { buildAuthority, buildMembershipGrant, createResolver, digestMultibase, type VerifiableCredential } from '@passport/credential-core';
import { verifyDTG, type VerifyPolicy } from './index.js';
import {
  BOULDER,
  CHALLENGE,
  DOMAIN,
  ENTERPRISE,
  OTHER_ENTERPRISE,
  STAFF_UNTIL,
  GARDEN_GROUP,
  NOW,
  T1_ACTIONS,
  TENANT_ZERO,
  FROM,
  ack,
  delegationHop,
  endorsement,
  grant,
  keys,
  membershipPair,
  payReceiveChain,
  present,
  sign,
  staticDids,
  vac,
} from '../scripts/fixtures.js';

const { boulder, tenantZero, group, alice, bob, carol } = keys;
const deps = (extra: Record<string, unknown> = {}) => ({ resolver: createResolver({ staticDocs: staticDids }), now: () => new Date(NOW), ...extra });
const policy = (extra: Partial<VerifyPolicy> = {}): VerifyPolicy => ({
  acceptedPods: [BOULDER],
  requireAuthority: ['event:attend'],
  challenge: CHALLENGE,
  domain: DOMAIN,
  podNames: { [BOULDER]: 'Boulder Commons' },
  ...extra,
});
const t1 = () => vac(boulder, alice.did, T1_ACTIONS, { tier: 'T1' });

describe('verifyDTG', () => {
  it('accepts a valid pair and explains itself in plain sentences', async () => {
    const r = await verifyDTG(present([...membershipPair(boulder, alice), t1(), endorsement(bob, alice)], alice), policy(), deps());
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ subject: alice.did, pod: BOULDER, tier: 'T1' });
    expect(r.authorities).toEqual([...T1_ACTIONS].sort());
    expect(r.explanation).toContain('Membership pair with Boulder Commons is complete.');
    expect(r.explanation.some((s) => s.startsWith('Authority event:attend is valid until 2026-12-15'))).toBe(true);
    expect(r.delegatedFor).toBeUndefined();
  });

  it('refuses a wrong challenge or domain with BAD_CHALLENGE', async () => {
    const vp = present([...membershipPair(boulder, alice), t1()], alice, { challenge: 'old-challenge' });
    expect((await verifyDTG(vp, policy(), deps())).error?.code).toBe('BAD_CHALLENGE');
    const vp2 = present([...membershipPair(boulder, alice), t1()], alice, { domain: 'evil.example' });
    expect((await verifyDTG(vp2, policy(), deps())).error?.code).toBe('BAD_CHALLENGE');
  });

  it('refuses a tampered presentation or credential with BAD_PROOF', async () => {
    const vp = present([...membershipPair(boulder, alice), t1()], alice);
    const tampered = { ...vp, holder: bob.did };
    expect((await verifyDTG(tampered, policy(), deps())).error?.code).toBe('BAD_PROOF');
    const vac2 = t1();
    vac2.credentialSubject['authority'].actions.push('vmc:grant');
    const r = await verifyDTG(present([...membershipPair(boulder, alice), vac2], alice), policy(), deps());
    expect(r.error?.code).toBe('BAD_PROOF');
    expect(r.ok).toBe(false);
  });

  it('refuses a presentation without membership credentials with NO_MEMBERSHIP', async () => {
    const r = await verifyDTG(present([t1()], alice), policy(), deps());
    expect(r.error?.code).toBe('NO_MEMBERSHIP');
  });

  it('does not require membership when the policy says so', async () => {
    const r = await verifyDTG(present([t1()], alice), policy({ requireMembership: false }), deps());
    expect(r.ok).toBe(true);
    expect(r.pod).toBeUndefined();
  });

  it('refuses when a required authority is missing', async () => {
    const r = await verifyDTG(present([...membershipPair(boulder, alice), t1()], alice), policy({ requireAuthority: ['round:vote'] }), deps());
    expect(r.error?.code).toBe('MISSING_AUTHORITY');
    expect(r.error?.message).toBe('No authority credential in this presentation gives you the right to round:vote.');
  });

  it('explains an expired authority with its date', async () => {
    const old = vac(boulder, alice.did, ['event:attend'], { validFrom: '2026-07-15T00:00:00Z', validUntil: '2026-09-01T00:00:00Z' });
    const r = await verifyDTG(present([...membershipPair(boulder, alice), old], alice), policy(), deps());
    expect(r.error).toEqual({ code: 'EXPIRED', message: 'This authority credential expired on 2026-09-01.' });
  });

  it('tolerates clock skew within maxClockSkewSec', async () => {
    const edge = vac(boulder, alice.did, ['event:attend'], { validUntil: '2026-09-30T23:58:00Z' });
    const vp = present([...membershipPair(boulder, alice), edge], alice);
    expect((await verifyDTG(vp, policy(), deps())).ok).toBe(true); // default 300 s
    expect((await verifyDTG(vp, policy({ maxClockSkewSec: 60 }), deps())).error?.code).toBe('EXPIRED');
  });

  it('refuses an authority issued by another pod', async () => {
    const foreign = vac(tenantZero, alice.did, ['event:attend']);
    const r = await verifyDTG(present([...membershipPair(boulder, alice), foreign], alice), policy(), deps());
    expect(r.error?.code).toBe('MISSING_AUTHORITY');
  });

  it('resolves accepted pods from a registry', async () => {
    const vp = present([...membershipPair(tenantZero, alice), vac(tenantZero, alice.did, ['event:attend'])], alice);
    const registry = { resolvePods: async () => [BOULDER, TENANT_ZERO] };
    const r = await verifyDTG(vp, policy({ acceptedPods: 'registry', registry }), deps());
    expect(r.ok).toBe(true);
    expect(r.pod).toBe(TENANT_ZERO);
  });

  it('accepts a group vote through an accepted delegation and reports delegatedFor', async () => {
    const vp = present(
      [...membershipPair(boulder, alice), ...delegationHop(group, alice, ['round:vote']), vac(boulder, GARDEN_GROUP, ['round:vote', 'round:propose', 'group:create'])],
      alice,
    );
    const r = await verifyDTG(vp, policy({ requireAuthority: ['round:vote'], allowDelegation: true }), deps());
    expect(r.ok).toBe(true);
    expect(r.delegatedFor).toBe(GARDEN_GROUP);
    // Only the delegated scope, not everything on the group's VAC.
    expect(r.authorities).toEqual(['round:vote']);
    expect(r.explanation).toContain('You act for garden-collective through a delegation of 1 hop.');
  });

  it('refuses a delegation the steward never accepted', async () => {
    const [grantOnly] = delegationHop(group, alice, ['round:vote']);
    const vp = present([...membershipPair(boulder, alice), grantOnly!, vac(boulder, GARDEN_GROUP, ['round:vote'])], alice);
    const r = await verifyDTG(vp, policy({ requireAuthority: ['round:vote'], allowDelegation: true }), deps());
    expect(r.error?.code).toBe('MISSING_AUTHORITY');
    expect(r.error?.message).toContain('never accepted');
  });

  it('ignores delegations when allowDelegation is off', async () => {
    const vp = present([...membershipPair(boulder, alice), ...delegationHop(group, alice, ['round:vote']), vac(boulder, GARDEN_GROUP, ['round:vote'])], alice);
    const r = await verifyDTG(vp, policy({ requireAuthority: ['round:vote'] }), deps());
    expect(r.error?.code).toBe('MISSING_AUTHORITY');
  });

  it('accepts pay:receive attenuated from owner to staff, reporting the enterprise', async () => {
    const { root, child } = payReceiveChain(bob, carol);
    const vp = present([...membershipPair(boulder, carol), root, child], carol);
    const r = await verifyDTG(vp, policy({ requireAuthority: [`pay:receive@${ENTERPRISE}`] }), deps());
    expect(r.ok).toBe(true);
    expect(r.authorities).toEqual([`pay:receive@${ENTERPRISE}`]);
    expect(r.explanation).toContain('Authority to receive payments at moxie-bread is valid until 2026-10-10.');
    expect(ENTERPRISE).toContain('moxie-bread');
  });

  it('refuses an attenuated VAC whose parent is not presented', async () => {
    const { child } = payReceiveChain(bob, carol);
    const r = await verifyDTG(present([...membershipPair(boulder, carol), child], carol), policy({ requireAuthority: [`pay:receive@${ENTERPRISE}`] }), deps());
    expect(r.error?.code).toBe('BROADENED_ATTENUATION');
  });

  it('refuses staff of enterprise A at a gate for enterprise B, and a bare pay:receive requirement', async () => {
    const { root, child } = payReceiveChain(bob, carol, ENTERPRISE);
    const vp = present([...membershipPair(boulder, carol), root, child], carol);
    const atB = await verifyDTG(vp, policy({ requireAuthority: [`pay:receive@${OTHER_ENTERPRISE}`] }), deps());
    expect(atB.error?.code).toBe('MISSING_AUTHORITY');
    const atA = await verifyDTG(vp, policy({ requireAuthority: [`pay:receive@${ENTERPRISE}`] }), deps());
    expect(atA.ok).toBe(true);
    const bare = await verifyDTG(vp, policy({ requireAuthority: ['pay:receive'] }), deps());
    expect(bare.error).toEqual({ code: 'MISSING_AUTHORITY', message: 'This gate needs pay:receive scoped to an enterprise.' });
  });

  it("uses the holder's own authority first; an unrelated delegation does not interfere", async () => {
    const vp = present(
      [...membershipPair(boulder, alice), vac(boulder, alice.did, ['round:vote']), ...delegationHop(group, alice, ['event:attend']), vac(boulder, GARDEN_GROUP, ['event:attend'])],
      alice,
    );
    const r = await verifyDTG(vp, policy({ requireAuthority: ['round:vote'], allowDelegation: true }), deps());
    expect(r.ok).toBe(true);
    expect(r.delegatedFor).toBeUndefined();
    expect(r.authorities).toEqual(['round:vote']);
  });

  it('requires a challenge and domain unless allowReplay is set', async () => {
    const vp = present([...membershipPair(boulder, alice), t1()], alice);
    const noChallenge = await verifyDTG(vp, policy({ challenge: undefined }), deps());
    expect(noChallenge.error).toEqual({ code: 'BAD_CHALLENGE', message: 'This gate requires a fresh challenge.' });
    expect((await verifyDTG(vp, policy({ domain: undefined }), deps())).error?.code).toBe('BAD_CHALLENGE');
    expect((await verifyDTG(vp, policy({ challenge: undefined, domain: undefined, allowReplay: true }), deps())).ok).toBe(true);
  });

  it('validates maxClockSkewSec and still refuses an expired VAC at the maximum skew', async () => {
    const vp = present([...membershipPair(boulder, alice), t1()], alice);
    await expect(verifyDTG(vp, policy({ maxClockSkewSec: Number.NaN }), deps())).rejects.toThrow('maxClockSkewSec must be a finite number between 0 and 600');
    await expect(verifyDTG(vp, policy({ maxClockSkewSec: 1e9 }), deps())).rejects.toThrow('maxClockSkewSec must be a finite number between 0 and 600');
    await expect(verifyDTG(vp, policy({ maxClockSkewSec: Infinity }), deps())).rejects.toThrow();
    await expect(verifyDTG(vp, policy({ maxClockSkewSec: -1 }), deps())).rejects.toThrow();
    const old = vac(boulder, alice.did, ['event:attend'], { validFrom: '2026-07-15T00:00:00Z', validUntil: '2026-09-01T00:00:00Z' });
    const r = await verifyDTG(present([...membershipPair(boulder, alice), old], alice), policy({ maxClockSkewSec: 600 }), deps());
    expect(r.error?.code).toBe('EXPIRED');
  });

  it('reports registry and status-list outages as UPSTREAM_UNAVAILABLE with a fixed sentence', async () => {
    const vp = present([...membershipPair(boulder, alice), t1()], alice);
    const registry = { resolvePods: async (): Promise<string[]> => { throw new Error('ECONNREFUSED 10.0.0.1:5432 secret-host'); } };
    const r = await verifyDTG(vp, policy({ acceptedPods: 'registry', registry }), deps());
    expect(r.error).toEqual({ code: 'UPSTREAM_UNAVAILABLE', message: 'The list of accepted pods could not be loaded right now, so this gate cannot decide.' });
  });

  describe('B3 §2 validity ceilings', () => {
    // Hand-signed credentials whose validity exceeds what the builders allow (builders would refuse).
    const overlong = (vc: VerifiableCredential, until: string): VerifiableCredential => ({ ...vc, validUntil: until });

    it('refuses a membership grant valid for more than 90 days', async () => {
      const unsigned = overlong(
        buildMembershipGrant({ pod: BOULDER, member: alice.did, bioregion: 'boulder', placeIds: [], governance: 'https://x', validFrom: FROM, validUntil: '2026-12-01T00:00:00Z', nonce: 'bm9uY2Utbm9uY2Utbm9uY2U' }),
        '2027-06-01T00:00:00Z',
      );
      const g = sign(unsigned, boulder);
      const r = await verifyDTG(present([g, ack(alice, boulder, digestMultibase(g)), t1()], alice), policy(), deps());
      expect(r.error).toEqual({ code: 'EXPIRED', message: 'This credential was issued with a longer validity than the profile allows.' });
    });

    it('refuses a root VAC over 90 days and an attenuated VAC over 30 days', async () => {
      const longRoot = sign(overlong(buildAuthority({ issuer: BOULDER, subject: alice.did, scope: BOULDER, actions: ['event:attend'], validFrom: FROM, validUntil: '2026-12-01T00:00:00Z' }), '2027-06-01T00:00:00Z'), boulder);
      expect((await verifyDTG(present([...membershipPair(boulder, alice), longRoot], alice), policy(), deps())).error?.code).toBe('EXPIRED');
      const { root } = payReceiveChain(bob, carol);
      const longChild = sign(
        buildAuthority({ issuer: bob.did, subject: carol.did, scope: ENTERPRISE, actions: ['pay:receive'], parent: digestMultibase(root), depth: 1, validFrom: FROM, validUntil: '2026-11-15T00:00:00Z' }),
        bob,
      );
      const r = await verifyDTG(present([...membershipPair(boulder, carol), root, longChild], carol), policy({ requireAuthority: [`pay:receive@${ENTERPRISE}`] }), deps());
      expect(r.error?.message).toBe('This credential was issued with a longer validity than the profile allows.');
      expect(STAFF_UNTIL).toBe('2026-10-10T00:00:00Z');
    });
  });

  it('refuses an ack with no grant as PAIR_INCOMPLETE', async () => {
    const g = grant(boulder, alice);
    const r = await verifyDTG(present([ack(alice, boulder, digestMultibase(g)), t1()], alice), policy(), deps());
    expect(r.error?.code).toBe('PAIR_INCOMPLETE');
  });

  describe('status lists', () => {
    const withStatus = (): VerifiableCredential => {
      const g = grant(boulder, alice);
      const { proof: _p, ...unsigned } = g;
      return sign({ ...unsigned, credentialStatus: { type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: '9', statusListCredential: 'https://bioregionalpassport.org/api/vta/status/1' } }, boulder);
    };
    const pairWithStatus = () => {
      const g = withStatus();
      return [g, ack(alice, boulder, digestMultibase(g))];
    };

    it('says the status list was not checked when no fetcher is given', async () => {
      const r = await verifyDTG(present([...pairWithStatus(), t1()], alice), policy(), deps());
      expect(r.ok).toBe(true);
      expect(r.explanation).toContain('Status list not checked.');
    });

    it('reports a failing status fetch as UPSTREAM_UNAVAILABLE without leaking the inner error', async () => {
      const r = await verifyDTG(present([...pairWithStatus(), t1()], alice), policy(), deps({ statusFetch: async () => { throw new Error('boom internal detail'); } }));
      expect(r.error).toEqual({ code: 'UPSTREAM_UNAVAILABLE', message: 'The credential status list could not be checked right now, so this gate cannot decide.' });
    });

    it('refuses a revoked credential as EXPIRED, mentioning revocation', async () => {
      const bits = new Uint8Array(16);
      bits[1] = 0b0100_0000; // index 9
      const r = await verifyDTG(present([...pairWithStatus(), t1()], alice), policy(), deps({ statusFetch: async () => bits }));
      expect(r.error?.code).toBe('EXPIRED');
      expect(r.error?.message).toMatch(/revoked/);
    });

    it('reads a gzip-compressed BitstringStatusListCredential', async () => {
      const bits = new Uint8Array(16);
      const gz = async (b: Uint8Array) => new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
      const { base64urlnopad } = await import('@scure/base');
      const list = { credentialSubject: { encodedList: 'u' + base64urlnopad.encode(await gz(bits)) } };
      const ok = await verifyDTG(present([...pairWithStatus(), t1()], alice), policy(), deps({ statusFetch: async () => list }));
      expect(ok.ok).toBe(true);
      bits[1] = 0b0100_0000;
      const revoked = { credentialSubject: { encodedList: 'u' + base64urlnopad.encode(await gz(bits)) } };
      const bad = await verifyDTG(present([...pairWithStatus(), t1()], alice), policy(), deps({ statusFetch: async () => revoked }));
      expect(bad.error?.code).toBe('EXPIRED');
    });

    it('skips status entirely with statusCheck never', async () => {
      const r = await verifyDTG(present([...pairWithStatus(), t1()], alice), policy({ statusCheck: 'never' }), deps());
      expect(r.ok).toBe(true);
      expect(r.explanation).not.toContain('Status list not checked.');
    });
  });
});
