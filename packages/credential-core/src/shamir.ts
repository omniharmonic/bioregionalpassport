import { randomBytes } from './encoding.js';

// GF(2^8) with the AES reduction polynomial x^8 + x^4 + x^3 + x + 1 (0x11b), generator 3.
const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // multiply by generator 3: x*2 ^ x
    let x2 = x << 1;
    if (x2 & 0x100) x2 ^= 0x11b;
    x = x2 ^ x;
  }
  for (let i = 255; i < 510; i++) EXP[i] = EXP[i - 255]!;
})();

const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);
const div = (a: number, b: number): number => {
  if (b === 0) throw new Error('Division by zero in GF(256).');
  return a === 0 ? 0 : EXP[LOG[a]! + 255 - LOG[b]!]!;
};

/**
 * Shamir secret sharing over GF(256), byte-wise. Each share is `[x, ...y]` with x = 1..shares.
 * A random polynomial of degree `threshold - 1` is used per byte (degree 1 for the 2-of-3 recovery kit).
 */
export function splitSecret(secret: Uint8Array, threshold: number = 2, shares: number = 3): Uint8Array[] {
  if (!Number.isInteger(threshold) || threshold < 2) throw new Error('threshold must be at least 2.');
  if (!Number.isInteger(shares) || shares < threshold || shares > 255) throw new Error('shares must be between threshold and 255.');
  if (secret.length === 0) throw new Error('secret must not be empty.');
  const out = Array.from({ length: shares }, (_, i) => {
    const s = new Uint8Array(secret.length + 1);
    s[0] = i + 1;
    return s;
  });
  for (let j = 0; j < secret.length; j++) {
    const coeffs = [secret[j]!, ...randomBytes(threshold - 1)];
    for (const share of out) {
      const x = share[0]!;
      let y = 0;
      for (let k = coeffs.length - 1; k >= 0; k--) y = mul(y, x) ^ coeffs[k]!; // Horner
      share[j + 1] = y;
    }
  }
  return out;
}

/** Recover the secret by Lagrange interpolation at x = 0. Supply at least `threshold` distinct shares. */
export function combineShares(shares: Uint8Array[]): Uint8Array {
  if (shares.length < 2) throw new Error('At least two shares are needed.');
  const len = shares[0]!.length;
  if (len < 2 || shares.some((s) => s.length !== len)) throw new Error('Shares have mismatched lengths.');
  const xs = shares.map((s) => s[0]!);
  if (xs.some((x) => x === 0) || new Set(xs).size !== xs.length) throw new Error('Shares must have distinct, non-zero indices.');
  const secret = new Uint8Array(len - 1);
  for (let j = 1; j < len; j++) {
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      let num = 1;
      let den = 1;
      for (let m = 0; m < shares.length; m++) {
        if (m === i) continue;
        num = mul(num, xs[m]!); // (0 - x_m) = x_m in GF(2^8)
        den = mul(den, xs[i]! ^ xs[m]!);
      }
      acc ^= mul(shares[i]![j]!, div(num, den));
    }
    secret[j - 1] = acc;
  }
  return secret;
}
