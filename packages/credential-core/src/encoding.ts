import { base58, base64urlnopad } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import jcs from 'canonicalize';

const te = new TextEncoder();
const td = new TextDecoder();

export const utf8 = (s: string): Uint8Array => te.encode(s);
export const fromUtf8 = (b: Uint8Array): string => td.decode(b);

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Multibase base58btc: `z` + base58btc(bytes). */
export const toBase58btc = (bytes: Uint8Array): string => 'z' + base58.encode(bytes);
export function fromBase58btc(mb: string): Uint8Array {
  if (typeof mb !== 'string' || !mb.startsWith('z')) throw new Error('Expected a base58btc multibase string starting with "z".');
  return base58.decode(mb.slice(1));
}

/** base64url without padding (RFC 4648 §5). */
export const toBase64url = (bytes: Uint8Array): string => base64urlnopad.encode(bytes);
export const fromBase64url = (s: string): Uint8Array => base64urlnopad.decode(s);

/** RFC 8785 JSON Canonicalization Scheme. Throws on values JSON cannot represent. */
export function canonicalize(obj: unknown): string {
  const out = jcs(obj);
  if (typeof out !== 'string') throw new Error('Value cannot be canonicalized as JSON.');
  return out;
}

/** sha256 over the UTF-8 bytes of the JCS form of `obj`. */
export const jcsHash = (obj: unknown): Uint8Array => sha256(utf8(canonicalize(obj)));

/**
 * DTG digest encoding: JCS → SHA-256 → multihash (0x12 sha2-256, 0x20 length) → base58btc multibase (`z…`).
 */
export function digestMultibase(obj: unknown): string {
  return toBase58btc(concatBytes(new Uint8Array([0x12, 0x20]), jcsHash(obj)));
}

/** Random bytes from WebCrypto (browser and Node 22). */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Random nonce, base64url (no padding). Default 16 bytes = 128 bits. */
export function randomNonce(bytes = 16): string {
  return toBase64url(randomBytes(bytes));
}
