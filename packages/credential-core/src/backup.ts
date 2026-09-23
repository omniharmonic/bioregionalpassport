import { fromBase64url, fromUtf8, randomBytes, toBase64url, utf8 } from './encoding.js';

export const BACKUP_PBKDF2_ITERATIONS = 210_000;

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto (globalThis.crypto.subtle) is not available.');
  return s;
};

// WebCrypto wants ArrayBuffer-backed views; copy into a fresh buffer to satisfy both runtimes and TS.
const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', buf(utf8(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations: BACKUP_PBKDF2_ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Passphrase backup: PBKDF2-SHA256 (210 000 iterations, 16-byte salt) → AES-256-GCM (12-byte IV).
 * Output is one base64url string encoding the JSON `{v:1,salt,iv,ct}` (fields base64url).
 */
export async function createBackup(secret: Uint8Array, passphrase: string): Promise<{ ciphertext: string }> {
  if (!passphrase) throw new Error('A passphrase is required.');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(secret)));
  const envelope = { v: 1, salt: toBase64url(salt), iv: toBase64url(iv), ct: toBase64url(ct) };
  return { ciphertext: toBase64url(utf8(JSON.stringify(envelope))) };
}

/** Open a backup made by `createBackup`. Throws on a wrong passphrase or corrupted data. */
export async function openBackup(ciphertext: string, passphrase: string): Promise<Uint8Array> {
  let env: { v?: unknown; salt?: unknown; iv?: unknown; ct?: unknown };
  try {
    env = JSON.parse(fromUtf8(fromBase64url(ciphertext)));
  } catch {
    throw new Error('This is not a passport backup.');
  }
  if (env.v !== 1 || typeof env.salt !== 'string' || typeof env.iv !== 'string' || typeof env.ct !== 'string') {
    throw new Error('Unsupported backup format.');
  }
  const key = await deriveKey(passphrase, fromBase64url(env.salt));
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: buf(fromBase64url(env.iv)) }, key, buf(fromBase64url(env.ct)));
    return new Uint8Array(pt);
  } catch {
    throw new Error('The backup could not be opened: wrong passphrase or damaged backup.');
  }
}
