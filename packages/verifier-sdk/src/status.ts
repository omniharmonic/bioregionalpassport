import { base64urlnopad } from '@scure/base';

/**
 * Fetches the status list named by a `BitstringStatusListEntry.statusListCredential` URL. It may return the
 * BitstringStatusListCredential JSON (`credentialSubject.encodedList` = multibase base64url, optionally GZIP
 * compressed per W3C Bitstring Status List) or the already-decoded bitstring bytes.
 */
export type StatusFetch = (url: string) => Promise<unknown>;

export interface BitstringStatusListEntry {
  type: 'BitstringStatusListEntry';
  statusPurpose?: string;
  statusListIndex: string | number;
  statusListCredential: string;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) throw new Error('This runtime cannot decompress status lists (no DecompressionStream).');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DS('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decode `encodedList`: multibase `u` (base64url, no padding) prefix optional; GZIP detected by magic bytes. */
export async function decodeEncodedList(encodedList: string): Promise<Uint8Array> {
  const b64 = encodedList.startsWith('u') ? encodedList.slice(1) : encodedList;
  const raw = base64urlnopad.decode(b64.replace(/=+$/, ''));
  return raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b ? gunzip(raw) : raw;
}

/** Bit `index` of a bitstring, most significant bit of the first byte is index 0 (W3C Bitstring Status List). */
export function bitAt(bits: Uint8Array, index: number): boolean {
  const byte = bits[Math.floor(index / 8)];
  if (byte === undefined) throw new Error(`Status index ${index} is outside the status list.`);
  return ((byte >> (7 - (index % 8))) & 1) === 1;
}

/** True when the entry's bit is set in the fetched list. Throws if the list cannot be read. */
export async function isRevoked(entry: BitstringStatusListEntry, fetch: StatusFetch): Promise<boolean> {
  const index = Number(entry.statusListIndex);
  if (!Number.isInteger(index) || index < 0) throw new Error('The credential status entry has an invalid index.');
  const list = await fetch(entry.statusListCredential);
  let bits: Uint8Array;
  if (list instanceof Uint8Array) bits = list;
  else {
    const encoded = (list as { credentialSubject?: { encodedList?: unknown } } | null)?.credentialSubject?.encodedList;
    if (typeof encoded !== 'string') throw new Error('The status list has no encodedList.');
    bits = await decodeEncodedList(encoded);
  }
  return bitAt(bits, index);
}
