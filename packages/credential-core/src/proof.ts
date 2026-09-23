import { concatBytes, fromBase58btc, jcsHash, toBase58btc } from './encoding.js';
import type { DidDocument, DidResolver } from './did.js';
import { publicKeyFromMultibase, signBytes, verifyBytes, type KeyPair } from './keys.js';

export type ProofPurpose = 'assertionMethod' | 'authentication';

export interface DataIntegrityProof {
  type: 'DataIntegrityProof';
  cryptosuite: 'eddsa-jcs-2022';
  created: string;
  verificationMethod: string;
  proofPurpose: ProofPurpose;
  challenge?: string;
  domain?: string;
  proofValue: string;
}

const PURPOSES: ProofPurpose[] = ['assertionMethod', 'authentication'];

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** ISO 8601 / XML Schema dateTimeStamp (timezone required). */
export const isDateTime = (v: unknown): v is string => typeof v === 'string' && DATE_TIME.test(v) && !Number.isNaN(Date.parse(v));

/**
 * eddsa-jcs-2022 hashData (W3C Data Integrity EdDSA Cryptosuites v1 §3.3):
 * sha256(JCS(proofConfig)) ‖ sha256(JCS(unsecured document)), where proofConfig is the proof
 * without `proofValue` and carrying the document's `@context` when it has one.
 */
function hashData(unsecured: Record<string, unknown>, proofOptions: Omit<DataIntegrityProof, 'proofValue'>): Uint8Array {
  const proofConfig: Record<string, unknown> = { ...proofOptions };
  if (unsecured['@context'] !== undefined) proofConfig['@context'] = unsecured['@context'];
  return concatBytes(jcsHash(proofConfig), jcsHash(unsecured));
}

function withoutProof(doc: object): Record<string, unknown> {
  const { proof: _proof, ...rest } = doc as Record<string, unknown>;
  return rest;
}

/** Sign `doc` with a DataIntegrityProof (eddsa-jcs-2022). Refuses documents that already carry a proof. */
export function signDocument<T extends object>(
  doc: T,
  key: KeyPair,
  opts: { proofPurpose?: string; challenge?: string; domain?: string; created?: string } = {},
): T & { proof: DataIntegrityProof } {
  if ((doc as Record<string, unknown>)['proof'] !== undefined) throw new Error('Document is already signed.');
  const proofPurpose = (opts.proofPurpose ?? 'assertionMethod') as ProofPurpose;
  if (!PURPOSES.includes(proofPurpose)) throw new Error(`Unsupported proofPurpose: ${opts.proofPurpose}`);
  if (opts.created !== undefined && !isDateTime(opts.created)) throw new Error(`created is not a valid ISO 8601 dateTime: ${opts.created}`);
  const options: Omit<DataIntegrityProof, 'proofValue'> = {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: opts.created ?? new Date().toISOString(),
    verificationMethod: key.kid,
    proofPurpose,
    ...(opts.challenge !== undefined ? { challenge: opts.challenge } : {}),
    ...(opts.domain !== undefined ? { domain: opts.domain } : {}),
  };
  const sig = signBytes(hashData(withoutProof(doc), options), key.privateKey);
  return { ...doc, proof: { ...options, proofValue: toBase58btc(sig) } };
}

function idOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') return (v as { id: string }).id;
  return undefined;
}

const absolute = (ref: string, did: string): string => (ref.startsWith('#') ? did + ref : ref);

function findMethod(doc: DidDocument, vmId: string, purpose: ProofPurpose) {
  const vm = (doc.verificationMethod ?? []).find((m) => absolute(m.id, doc.id) === vmId);
  if (!vm) return { error: `Verification method ${vmId} is not in the DID document.` };
  if (absolute(vm.controller, doc.id) !== doc.id) return { error: `Verification method ${vmId} is not controlled by ${doc.id}.` };
  const rel = (doc[purpose] ?? []) as unknown[];
  const authorized = rel.some((r) => {
    const id = idOf(r);
    return id !== undefined && absolute(id, doc.id) === vmId;
  });
  if (!authorized) return { error: `Verification method ${vmId} is not authorized for ${purpose}.` };
  return { vm };
}

/**
 * Verify a DataIntegrityProof (eddsa-jcs-2022). The controller DID is the part of
 * `proof.verificationMethod` before `#`; it is resolved and the method must be listed under the proof's purpose.
 *
 * Binding checks (beyond the signature), whatever the proof purpose:
 * - a document with an `issuer` (credential) must be signed by that issuer, with `assertionMethod`;
 * - a document with a `holder` (presentation) must be signed by that holder, with `authentication`;
 * - `proof.created` must be an ISO 8601 dateTime and the method's `controller` must be the resolved DID;
 * - `opts.challenge` / `opts.domain` / `opts.proofPurpose`, when given, must equal the proof's values.
 */
export async function verifyDocument(
  doc: { proof: DataIntegrityProof },
  resolver: DidResolver,
  opts: { challenge?: string; domain?: string; proofPurpose?: ProofPurpose } = {},
): Promise<{ ok: boolean; error?: string; controller?: string }> {
  try {
    const proof = doc?.proof;
    if (!proof || typeof proof !== 'object') return { ok: false, error: 'Document has no proof.' };
    if (proof.type !== 'DataIntegrityProof' || proof.cryptosuite !== 'eddsa-jcs-2022') {
      return { ok: false, error: 'Proof is not a DataIntegrityProof using eddsa-jcs-2022.' };
    }
    if (!PURPOSES.includes(proof.proofPurpose)) return { ok: false, error: `Unsupported proofPurpose: ${proof.proofPurpose}` };
    if (typeof proof.proofValue !== 'string' || typeof proof.verificationMethod !== 'string') {
      return { ok: false, error: 'Proof is missing proofValue or verificationMethod.' };
    }
    if (opts.proofPurpose && proof.proofPurpose !== opts.proofPurpose) {
      return { ok: false, error: `Expected proofPurpose ${opts.proofPurpose}, got ${proof.proofPurpose}.` };
    }
    if (opts.challenge !== undefined && proof.challenge !== opts.challenge) return { ok: false, error: 'Challenge does not match.' };
    if (opts.domain !== undefined && proof.domain !== opts.domain) return { ok: false, error: 'Domain does not match.' };

    if (!isDateTime(proof.created)) return { ok: false, error: 'Proof created is not a valid ISO 8601 dateTime.' };

    const controller = proof.verificationMethod.split('#')[0] as string;
    const unsecured = withoutProof(doc);
    // Signer binding holds regardless of proof purpose: a credential must be signed by its issuer with
    // assertionMethod, a presentation by its holder with authentication.
    if (unsecured['issuer'] !== undefined) {
      if (idOf(unsecured['issuer']) !== controller) return { ok: false, error: 'Proof was not made by the credential issuer.' };
      if (proof.proofPurpose !== 'assertionMethod') return { ok: false, error: 'A credential proof must use proofPurpose assertionMethod.' };
    }
    if (unsecured['holder'] !== undefined) {
      if (idOf(unsecured['holder']) !== controller) return { ok: false, error: 'Proof was not made by the presentation holder.' };
      if (proof.proofPurpose !== 'authentication') return { ok: false, error: 'A presentation proof must use proofPurpose authentication.' };
    }

    const didDoc = await resolver.resolve(controller);
    const found = findMethod(didDoc, proof.verificationMethod, proof.proofPurpose);
    if (!found.vm) return { ok: false, error: found.error };

    const { proofValue, ...options } = proof;
    const ok = verifyBytes(fromBase58btc(proofValue), hashData(unsecured, options), publicKeyFromMultibase(found.vm.publicKeyMultibase));
    return ok ? { ok: true, controller } : { ok: false, error: 'Signature is invalid.', controller };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
