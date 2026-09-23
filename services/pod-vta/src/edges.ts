import { digestMultibase, verifyDocument, type DataIntegrityProof, type DidResolver, type VerifiableCredential } from '@passport/credential-core';
import { isObject } from './util.js';

type SignedVc = VerifiableCredential & { proof: DataIntegrityProof };

const isVrc = (v: unknown): v is SignedVc =>
  isObject(v) &&
  Array.isArray(v['type']) &&
  v['type'].includes('VerifiableCredential') &&
  v['type'].includes('RelationshipCredential') &&
  typeof v['issuer'] === 'string' &&
  typeof v['credentialSubject']?.id === 'string' &&
  !!v['proof'];

/**
 * Pair-digest rule: a witnessed edge is the VRC PAIR. Its digest is
 * `digestMultibase({ a, b })` where `a`/`b` are the two halves' `digestMultibase` sorted ascending, so the order
 * in which the halves are given does not matter.
 */
export function edgePairDigest(x: VerifiableCredential, y: VerifiableCredential): string {
  const [a, b] = [digestMultibase(x), digestMultibase(y)].sort() as [string, string];
  return digestMultibase({ a, b });
}

/** True when the two halves mirror each other (A.issuer = B.subject, B.issuer = A.subject) between distinct DIDs. */
export function isMirroredPair(x: VerifiableCredential, y: VerifiableCredential): boolean {
  return (
    x.issuer === y.credentialSubject.id &&
    y.issuer === x.credentialSubject.id &&
    x.issuer !== y.issuer
  );
}

export type PairCheck = { ok: true; parties: [string, string]; digest: string; a: SignedVc; b: SignedVc } | { ok: false; reason: string };

/** Structural + signature check of a VRC pair; each half must be signed by its own issuer. */
export async function checkVrcPair(x: unknown, y: unknown, resolver: DidResolver): Promise<PairCheck> {
  if (!isVrc(x) || !isVrc(y)) return { ok: false, reason: 'Both halves must be signed RelationshipCredentials.' };
  if (!isMirroredPair(x, y)) return { ok: false, reason: 'The two halves are not one relationship between two different people.' };
  for (const half of [x, y]) {
    const r = await verifyDocument(half, resolver, { proofPurpose: 'assertionMethod' });
    if (!r.ok) return { ok: false, reason: `A relationship half signature did not check out (${r.error}).` };
  }
  return { ok: true, parties: [x.issuer, y.issuer], digest: edgePairDigest(x, y), a: x, b: y };
}

/** Finds, among presented credentials, a VRC pair whose pair digest is `digest`. */
export function findPair(creds: unknown[], digest: string): [SignedVc, SignedVc] | undefined {
  const vrcs = creds.filter(isVrc);
  for (let i = 0; i < vrcs.length; i++) {
    for (let j = i + 1; j < vrcs.length; j++) {
      if (isMirroredPair(vrcs[i]!, vrcs[j]!) && edgePairDigest(vrcs[i]!, vrcs[j]!) === digest) return [vrcs[i]!, vrcs[j]!];
    }
  }
  return undefined;
}
