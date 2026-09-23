import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, fromBase58btc, randomBytes, toBase58btc, utf8 } from './encoding.js';

export type DidScope = 'public' | 'directed' | 'pairwise';

export interface KeyPair {
  did: string;
  publicKeyMultibase: string;
  /** 32-byte Ed25519 secret key (seed). */
  privateKey: Uint8Array;
  /** `${did}#${fragment}` */
  kid: string;
}

/** Multicodec varint prefix for ed25519-pub (0xed). */
const ED25519_PUB_PREFIX = new Uint8Array([0xed, 0x01]);

/** Multikey encoding of an Ed25519 public key: `z` + base58btc(0xed01 ‖ pubkey). */
export function publicKeyToMultibase(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('Ed25519 public key must be 32 bytes.');
  return toBase58btc(concatBytes(ED25519_PUB_PREFIX, publicKey));
}

/** Decode a Multikey `z…` string into the raw 32-byte Ed25519 public key. */
export function publicKeyFromMultibase(publicKeyMultibase: string): Uint8Array {
  const bytes = fromBase58btc(publicKeyMultibase);
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) {
    throw new Error('Public key is not an Ed25519 Multikey (expected multicodec 0xed01 and 32 key bytes).');
  }
  return bytes.slice(2);
}

/** `did:key:z…` for an Ed25519 public key multibase. */
export const didKeyFromMultibase = (publicKeyMultibase: string): string => `did:key:${publicKeyMultibase}`;

/** Decode a did:key into its public key multibase (validating the Ed25519 multicodec). */
export function multibaseFromDidKey(did: string): string {
  if (!did.startsWith('did:key:')) throw new Error(`Not a did:key: ${did}`);
  const mb = did.slice('did:key:'.length).split('#')[0] ?? '';
  publicKeyFromMultibase(mb);
  return mb;
}

/** Deterministic did:key key pair from a 32-byte seed (the Ed25519 secret key). */
export function keyPairFromSeed(seed: Uint8Array): KeyPair {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('Seed must be 32 bytes.');
  const privateKey = Uint8Array.from(seed);
  const publicKeyMultibase = publicKeyToMultibase(ed25519.getPublicKey(privateKey));
  const did = didKeyFromMultibase(publicKeyMultibase);
  return { did, publicKeyMultibase, privateKey, kid: `${did}#${publicKeyMultibase}` };
}

/** New did:key key pair; random unless a seed is supplied. */
export function generateKeyPair(seed?: Uint8Array): KeyPair {
  return keyPairFromSeed(seed ?? randomBytes(32));
}

/**
 * Per-round voting key (B3 §1): HKDF-SHA256(ikm = persona seed, salt = none, info = `round:${roundId}`, 32 bytes)
 * used as the Ed25519 seed of a pairwise did:key.
 */
export function deriveRoundKey(personaSeed: Uint8Array, roundId: string): KeyPair {
  return keyPairFromSeed(hkdf(sha256, personaSeed, undefined, utf8(`round:${roundId}`), 32));
}

/**
 * Re-bind a secret key to another DID (e.g. a pod's did:web) so it can sign as that DID.
 * The verification method is `${did}#${fragment}` (default `key-1`, matching `didWebDocument`).
 */
export function keyPairForDid(did: string, privateKey: Uint8Array, fragment = 'key-1'): KeyPair {
  const base = keyPairFromSeed(privateKey);
  return { did, publicKeyMultibase: base.publicKeyMultibase, privateKey: base.privateKey, kid: `${did}#${fragment}` };
}

export function signBytes(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, privateKey);
}

export function verifyBytes(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}
