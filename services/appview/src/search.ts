/** `GET /search` — simple ILIKE search across name/title/description of every open-record collection. */
import { COLLECTIONS } from '@passport/lexicons';
import type { PodContext } from './kit.js';
import { listRecords, type RecordRow } from './records.js';

export async function searchRecords(ctx: PodContext, q: string): Promise<RecordRow[]> {
  if (!q.trim()) return [];
  const results = await Promise.all(
    COLLECTIONS.map((collection) => listRecords(ctx, collection, { q, limit: 25 })),
  );
  return results.flat();
}
