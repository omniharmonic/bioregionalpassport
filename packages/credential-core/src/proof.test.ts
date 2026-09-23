import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  createPresentation,
  createResolver,
  digestMultibase,
  didWebDocument,
  didWebFromDomainPath,
  generateKeyPair,
  keyPairForDid,
  signDocument,
  verifyDocument,
  buildEndorsement,
} from './index.js';

describe('JCS and digests', () => {
  it('canonicalizes per RFC 8785', () => {
    expect(canonicalize({ b: 2, a: [1, 'x', null, true], c: { z: 1, y: 2 } })).toBe('{"a":[1,"x",null,true],"b":2,"c":{"y":2,"z":1}}');
    expect(canonicalize({ n: 1.0, e: 1e21, s: '€' })).toBe('{"e":1e+21,"n":1,"s":"€"}');
    expect(() => canonicalize(undefined)).toThrow();
  });

  it('digestMultibase known answer and key-order stability', () => {
    // Known answer recorded on first run and cross-checked with node:crypto sha256 + base58btc:
    // z + base58btc(0x12 0x20 ‖ sha256('{"a":1}')).
    expect(digestMultibase({ a: 1 })).toBe('zQmNRwNKPCo7tufiPf7zBwJhKdswzFLyWHE5am6tAXP7EbB');
    expect(digestMultibase({ a: 1, b: { c: 2, d: 3 } })).toBe(digestMultibase({ b: { d: 3, c: 2 }, a: 1 }));
    expect(digestMultibase({ a: 1 })).not.toBe(digestMultibase({ a: 2 }));
    expect(digestMultibase({ a: 1 })).toMatch(/^zQm/);
  });
});

describe('eddsa-jcs-2022 proofs', () => {
  const resolver = createResolver();

  it('sign/verify roundtrip with did:key', async () => {
    const kp = generateKeyPair();
    const doc = { '@context': ['https://www.w3.org/ns/credentials/v2'], issuer: kp.did, hello: 'world' };
    const signed = signDocument(doc, kp, { created: '2026-09-22T00:00:00Z' });
    expect(signed.proof).toMatchObject({
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: '2026-09-22T00:00:00Z',
      verificationMethod: kp.kid,
      proofPurpose: 'assertionMethod',
    });
    expect(signed.proof.proofValue).toMatch(/^z/);
    expect(await verifyDocument(signed, resolver)).toEqual({ ok: true, controller: kp.did });
    expect(() => signDocument(signed, kp)).toThrow(/already signed/);
  });

  it('is deterministic (ed25519) for identical inputs', () => {
    const kp = generateKeyPair(new Uint8Array(32).fill(3));
    const a = signDocument({ x: 1 }, kp, { created: '2026-01-01T00:00:00Z' });
    const b = signDocument({ x: 1 }, kp, { created: '2026-01-01T00:00:00Z' });
    expect(a.proof.proofValue).toBe(b.proof.proofValue);
  });

  it('detects tampering with the document or the proof', async () => {
    const kp = generateKeyPair();
    const signed = signDocument({ issuer: kp.did, value: 1 }, kp);
    expect((await verifyDocument({ ...signed, value: 2 } as typeof signed, resolver)).ok).toBe(false);
    expect((await verifyDocument({ ...signed, proof: { ...signed.proof, created: '2020-01-01T00:00:00Z' } }, resolver)).ok).toBe(false);
    const other = generateKeyPair();
    const r = await verifyDocument({ ...signed, proof: { ...signed.proof, verificationMethod: other.kid } }, resolver);
    expect(r.ok).toBe(false);
    expect((await verifyDocument({ value: 1 } as any, resolver)).ok).toBe(false);
  });

  it('refuses a proof not made by the issuer', async () => {
    const issuer = generateKeyPair();
    const imposter = generateKeyPair();
    const signed = signDocument({ issuer: issuer.did, v: 1 }, imposter);
    const r = await verifyDocument(signed, resolver);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/issuer/);
  });

  it('refuses a credential forged with proofPurpose authentication (Critical 1)', async () => {
    const podDid = didWebFromDomainPath('bioregionalpassport.org', 'dids', 'boulder');
    const attacker = generateKeyPair();
    const vc = { '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'MembershipCredential'], issuer: podDid, credentialSubject: { id: attacker.did } };
    const forged = signDocument(vc, attacker, { proofPurpose: 'authentication' });
    const r = await verifyDocument(forged, resolver);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/issuer/);
    // even the real issuer must use assertionMethod for a credential
    const self = { ...vc, issuer: attacker.did };
    const wrongPurpose = await verifyDocument(signDocument(self, attacker, { proofPurpose: 'authentication' }), resolver);
    expect(wrongPurpose.ok).toBe(false);
    expect(wrongPurpose.error).toMatch(/assertionMethod/);
  });

  it('refuses a presentation for a victim holder signed with assertionMethod (Critical 1)', async () => {
    const victim = generateKeyPair();
    const attacker = generateKeyPair();
    const vp = { '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiablePresentation'], holder: victim.did, verifiableCredential: [] };
    const forged = signDocument(vp, attacker, { proofPurpose: 'assertionMethod', challenge: 'c', domain: 'd' });
    const r = await verifyDocument(forged, resolver, { challenge: 'c', domain: 'd' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/holder/);
    const ownWrongPurpose = signDocument({ ...vp, holder: attacker.did }, attacker, { proofPurpose: 'assertionMethod', challenge: 'c', domain: 'd' });
    expect((await verifyDocument(ownWrongPurpose, resolver, { challenge: 'c', domain: 'd' })).error).toMatch(/authentication/);
  });

  it('validates proof.created', async () => {
    const kp = generateKeyPair();
    expect(() => signDocument({ x: 1 }, kp, { created: 'yesterday' })).toThrow(/dateTime/);
    const signed = signDocument({ x: 1 }, kp);
    const r = await verifyDocument({ ...signed, proof: { ...signed.proof, created: 'not-a-date' } }, resolver);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/created/);
  });

  it('refuses a verification method whose controller is another DID', async () => {
    const did = 'did:web:bioregionalpassport.org:dids:boulder';
    const key = keyPairForDid(did, generateKeyPair().privateKey);
    const doc = didWebDocument(did, key.publicKeyMultibase);
    doc.verificationMethod[0]!.controller = 'did:web:evil.example';
    const r = await verifyDocument(signDocument({ issuer: did }, key), createResolver({ staticDocs: { [did]: doc } }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/controlled/);
  });

  it('binds challenge and domain', async () => {
    const kp = generateKeyPair();
    const signed = signDocument({ holder: kp.did }, kp, { proofPurpose: 'authentication', challenge: 'c1', domain: 'boulder.example' });
    expect((await verifyDocument(signed, resolver, { challenge: 'c1', domain: 'boulder.example' })).ok).toBe(true);
    expect((await verifyDocument(signed, resolver, { challenge: 'c2' })).ok).toBe(false);
    expect((await verifyDocument(signed, resolver, { domain: 'evil.example' })).ok).toBe(false);
    // Changing the challenge in the proof breaks the signature
    expect((await verifyDocument({ ...signed, proof: { ...signed.proof, challenge: 'c2' } }, resolver)).ok).toBe(false);
    expect((await verifyDocument({ ...signed, proof: { ...signed.proof, domain: 'x' } }, resolver)).ok).toBe(false);
  });

  it('verifies a did:web signer via static docs and enforces the verification relationship', async () => {
    const did = didWebFromDomainPath('bioregionalpassport.org', 'dids', 'boulder');
    const key = keyPairForDid(did, generateKeyPair().privateKey);
    const doc = didWebDocument(did, key.publicKeyMultibase);
    const signed = signDocument({ issuer: did, n: 1 }, key);
    expect(await verifyDocument(signed, createResolver({ staticDocs: { [did]: doc } }))).toEqual({ ok: true, controller: did });
    const noAssert = { ...doc, assertionMethod: [] };
    const r = await verifyDocument(signed, createResolver({ staticDocs: { [did]: noAssert } }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not authorized/);
  });
});

describe('presentations', () => {
  it('creates and verifies a presentation bound to challenge and domain', async () => {
    const resolver = createResolver();
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const vc = signDocument(buildEndorsement({ issuer: bob.did, subject: alice.did, scope: 'knows' }), bob);
    const vp = createPresentation([vc], alice, { challenge: 'nonce-123', domain: 'boulder.bioregionalpassport.org' });
    expect(vp.type).toEqual(['VerifiablePresentation']);
    expect(vp.holder).toBe(alice.did);
    expect(vp.proof).toMatchObject({ proofPurpose: 'authentication', challenge: 'nonce-123', domain: 'boulder.bioregionalpassport.org' });
    expect(await verifyDocument(vp as any, resolver, { challenge: 'nonce-123', domain: 'boulder.bioregionalpassport.org', proofPurpose: 'authentication' })).toEqual({ ok: true, controller: alice.did });
    expect((await verifyDocument(vp.verifiableCredential[0] as any, resolver)).ok).toBe(true);
    expect((await verifyDocument(vp as any, resolver, { challenge: 'other' })).ok).toBe(false);
    // Swapping in another credential breaks the VP signature
    const vc2 = signDocument(buildEndorsement({ issuer: bob.did, subject: alice.did, scope: 'lives-here' }), bob);
    expect((await verifyDocument({ ...vp, verifiableCredential: [vc2] } as any, resolver)).ok).toBe(false);
    // Someone else cannot present as alice
    const forged = createPresentation([vc], bob, { challenge: 'nonce-123', domain: 'd' });
    expect((await verifyDocument({ ...forged, holder: alice.did } as any, resolver)).ok).toBe(false);
  });
});
