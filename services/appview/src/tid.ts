/**
 * Generates a TID-like record key: a base32-sortable string encoding a
 * microsecond timestamp plus a random tie-breaker, so record keys sort in
 * creation order (same shape as an ATProto TID, ADR-24's migration target).
 */
const B32_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';

let lastMicros = 0n;

export function generateTid(now: () => Date = () => new Date()): string {
  // Ensure strictly increasing micros even for calls within the same
  // millisecond (Date.now() resolution), so ids stay sortable.
  let micros = BigInt(now().getTime()) * 1000n;
  if (micros <= lastMicros) {
    micros = lastMicros + 1n;
  }
  lastMicros = micros;

  const clockId = BigInt(Math.floor(Math.random() * 1024));
  // Top bit must be 0 per the TID spec so values stay positive/sortable.
  let value = ((micros << 10n) | clockId) & 0x7fffffffffffffffn;

  let out = '';
  for (let i = 0; i < 13; i++) {
    out = B32_ALPHABET[Number(value & 0x1fn)] + out;
    value >>= 5n;
  }
  return out;
}
