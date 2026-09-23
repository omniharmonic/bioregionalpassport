/**
 * Generates the eight B3 §10 conformance vectors into `vectors/<name>.json`.
 * Run: `pnpm --filter @passport/verifier-sdk gen-vectors` (tsx). Output is deterministic.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestMultibase, type VerifiablePresentation } from '@passport/credential-core';
import {
  BOULDER,
  CHALLENGE,
  DOMAIN,
  GARDEN_GROUP,
  NOW,
  T1_ACTIONS,
  ack,
  broadenedChain,
  delegationHop,
  grant,
  keys,
  membershipPair,
  present,
  statement,
  staticDids,
  vac,
} from './fixtures.js';
import type { VerifyPolicy } from '../src/verify.js';

export interface ConformanceVector {
  name: string;
  description: string;
  now: string;
  presentation: VerifiablePresentation;
  policy: VerifyPolicy;
  staticDids: typeof staticDids;
  expected: { ok: boolean; errorCode?: string; authorities?: string[] };
}

const basePolicy = (extra: Partial<VerifyPolicy> = {}): VerifyPolicy => ({
  acceptedPods: [BOULDER],
  requireMembership: true,
  requireAuthority: ['event:attend'],
  maxClockSkewSec: 300,
  statusCheck: 'ifPresent',
  challenge: CHALLENGE,
  domain: DOMAIN,
  ...extra,
});

const { boulder, tenantZero, group, alice, bob, carol } = keys;

export function buildVectors(): ConformanceVector[] {
  const v = (
    name: string,
    description: string,
    presentation: VerifiablePresentation,
    policy: VerifyPolicy,
    expected: ConformanceVector['expected'],
  ): ConformanceVector => ({ name, description, now: NOW, presentation, policy, staticDids, expected });

  const t1 = () => vac(boulder, alice.did, T1_ACTIONS, { tier: 'T1' });
  const aliceGrant = grant(boulder, alice);
  const otherGrant = grant(boulder, alice, 'b3RoZXItbm9uY2Utb3RoZXI');
  const broad = broadenedChain(bob, carol);

  return [
    v('valid-pair', 'A complete membership pair with Boulder plus a T1 authority credential; the gate asks for event:attend.',
      present([...membershipPair(boulder, alice), t1()], alice), basePolicy(),
      { ok: true, authorities: [...T1_ACTIONS].sort() }),
    v('grant-without-ack', 'The pod granted membership but the member never acknowledged it.',
      present([aliceGrant, t1()], alice), basePolicy(), { ok: false, errorCode: 'PAIR_INCOMPLETE' }),
    v('ack-digest-mismatch', 'The acknowledgement carries the digest of a different grant (another nonce).',
      present([aliceGrant, ack(alice, boulder, digestMultibase(otherGrant)), t1()], alice), basePolicy(),
      { ok: false, errorCode: 'DIGEST_MISMATCH' }),
    v('expired-vac', 'The authority credential expired on 2026-09-01, before the verification time.',
      present([...membershipPair(boulder, alice), vac(boulder, alice.did, T1_ACTIONS, { tier: 'T1', validFrom: '2026-07-15T00:00:00Z', validUntil: '2026-09-01T00:00:00Z' })], alice),
      basePolicy(), { ok: false, errorCode: 'EXPIRED' }),
    v('broadened-attenuation', 'An owner attenuated pay:receive to staff but added credit:account, which the parent does not hold.',
      present([...membershipPair(boulder, carol), broad.root, broad.child], carol), basePolicy({ requireAuthority: ['pay:receive'] }),
      { ok: false, errorCode: 'BROADENED_ATTENUATION' }),
    v('vdc-chain-exceeding-depth', 'The garden group delegated round:vote to a steward with maxDepth 0, who re-delegated it to the voter.',
      present([...membershipPair(boulder, alice), ...delegationHop(group, bob, ['round:vote'], 0), ...delegationHop(bob, alice, ['round:vote'], 0), vac(boulder, GARDEN_GROUP, ['round:vote'])], alice),
      basePolicy({ requireAuthority: ['round:vote'], allowDelegation: true }), { ok: false, errorCode: 'CHAIN_TOO_DEEP' }),
    v('unknown-predicate', 'The presentation carries a statement whose predicate is not in the published vocabulary.',
      present([...membershipPair(boulder, alice), t1(), statement(bob, alice, 'bioregion:admires')], alice), basePolicy(),
      { ok: false, errorCode: 'UNKNOWN_PREDICATE' }),
    v('pod-mismatch', 'A complete membership pair with tenant-zero presented at a gate that accepts only Boulder.',
      present([...membershipPair(tenantZero, alice), vac(tenantZero, alice.did, T1_ACTIONS, { tier: 'T1' })], alice), basePolicy(),
      { ok: false, errorCode: 'POD_MISMATCH' }),
  ];
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'vectors');
  mkdirSync(out, { recursive: true });
  for (const vector of buildVectors()) {
    writeFileSync(join(out, `${vector.name}.json`), `${JSON.stringify(vector, null, 2)}\n`);
    console.log(`wrote vectors/${vector.name}.json`);
  }
}
