import { describe, expect, it } from 'vitest';
import { combineShares, createBackup, fromBase64url, openBackup, randomNonce, splitSecret } from './index.js';

describe('passphrase backup', () => {
  it('round-trips and rejects a wrong passphrase', async () => {
    const secret = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const { ciphertext } = await createBackup(secret, 'correct horse battery staple');
    expect(ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);
    const env = JSON.parse(new TextDecoder().decode(fromBase64url(ciphertext)));
    expect(Object.keys(env).sort()).toEqual(['ct', 'iv', 'salt', 'v']);
    expect(env.v).toBe(1);
    expect(await openBackup(ciphertext, 'correct horse battery staple')).toEqual(secret);
    await expect(openBackup(ciphertext, 'wrong')).rejects.toThrow(/wrong passphrase/);
    await expect(openBackup('not-a-backup', 'x')).rejects.toThrow();
  });
});

describe('Shamir 2-of-3', () => {
  it('recovers from any two shares', () => {
    const secret = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const shares = splitSecret(secret, 2, 3);
    expect(shares).toHaveLength(3);
    expect(shares.map((s) => s[0])).toEqual([1, 2, 3]);
    for (const [i, j] of [[0, 1], [0, 2], [1, 2], [2, 0], [1, 0]] as const) {
      expect(combineShares([shares[i]!, shares[j]!])).toEqual(secret);
    }
    expect(combineShares(shares)).toEqual(secret);
  });

  it('a single share reveals nothing useful and is refused', () => {
    const secret = new Uint8Array(32).fill(0xaa);
    const shares = splitSecret(secret, 2, 3);
    expect(shares[0]!.slice(1)).not.toEqual(secret);
    expect(() => combineShares([shares[0]!])).toThrow();
    expect(() => combineShares([shares[0]!, shares[0]!])).toThrow(/distinct/);
  });

  it('handles edge bytes', () => {
    const secret = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    const shares = splitSecret(secret, 2, 3);
    expect(combineShares([shares[2]!, shares[1]!])).toEqual(secret);
  });
});

describe('randomNonce', () => {
  it('is base64url, 128 bits by default', () => {
    const n = randomNonce();
    expect(n).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromBase64url(n).length).toBe(16);
    expect(fromBase64url(randomNonce(32)).length).toBe(32);
    expect(randomNonce()).not.toBe(n);
  });
});
