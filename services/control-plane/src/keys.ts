import { base64urlnopad } from '@scure/base';

const HEX64 = /^[0-9a-fA-F]{64}$/;

function masterKeyBytes(masterKey: string): Uint8Array<ArrayBuffer> {
  if (typeof masterKey !== 'string' || !HEX64.test(masterKey)) {
    throw new Error('POD_KEY_ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(masterKey.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto (globalThis.crypto.subtle) is not available.');
  return s;
}

async function importKey(masterKey: string): Promise<CryptoKey> {
  return subtle().importKey('raw', masterKeyBytes(masterKey), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const aad = (context: string | undefined): { additionalData?: Uint8Array<ArrayBuffer> } =>
  context === undefined ? {} : { additionalData: new TextEncoder().encode(context) };

/**
 * AES-256-GCM encrypt (ADR-27). Output: `base64url(iv) + '.' + base64url(ciphertext‖tag)`.
 * `context` (the control plane passes `slug|kid`) is bound as additional authenticated data, so a
 * ciphertext copied onto another pod or key id fails to decrypt.
 */
export async function encryptPrivateKey(privateKey: Uint8Array, masterKey: string, context?: string): Promise<string> {
  const key = await importKey(masterKey);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, ...aad(context) }, key, Uint8Array.from(privateKey)));
  return `${base64urlnopad.encode(iv)}.${base64urlnopad.encode(ct)}`;
}

/** Inverse of `encryptPrivateKey`; throws a plain-sentence error when the master key is wrong. */
export async function decryptPrivateKey(
  encrypted: string,
  masterKey: string,
  slug = 'this pod',
  context?: string,
): Promise<Uint8Array> {
  const key = await importKey(masterKey);
  const [ivPart, ctPart, ...rest] = String(encrypted).split('.');
  if (!ivPart || !ctPart || rest.length > 0) throw new Error(`The stored key for ${slug} is not in the iv.ciphertext format.`);
  let iv: Uint8Array<ArrayBuffer>;
  let ct: Uint8Array<ArrayBuffer>;
  try {
    iv = Uint8Array.from(base64urlnopad.decode(ivPart));
    ct = Uint8Array.from(base64urlnopad.decode(ctPart));
  } catch {
    throw new Error(`The stored key for ${slug} is not valid base64url.`);
  }
  if (iv.length !== 12) throw new Error(`The stored key for ${slug} has a ${iv.length}-byte IV; expected 12.`);
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt(
      { name: 'AES-GCM', iv, ...aad(context) },
      key,
      ct,
    );
  } catch {
    throw new Error(
      `Could not decrypt the signing key for ${slug}: POD_KEY_ENCRYPTION_KEY does not match the key it was encrypted with.`,
    );
  }
  const bytes = new Uint8Array(plain);
  if (bytes.length !== 32) throw new Error(`The decrypted key for ${slug} is not 32 bytes.`);
  return bytes;
}
