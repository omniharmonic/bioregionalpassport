/** `GET /directory` — enterprises with their offer/need counts (MVP plan §5 Task 10). */
import type { PodContext } from './kit.js';
import { listRecords, type RecordRow } from './records.js';

export interface DirectoryFilter {
  category?: string;
  q?: string;
  acceptsLocalCredit?: boolean;
}

export interface DirectoryEntry {
  uri: string;
  record: Record<string, unknown>;
  offerCount: number;
  needCount: number;
}

export async function listDirectory(ctx: PodContext, filter: DirectoryFilter = {}): Promise<DirectoryEntry[]> {
  const { rows: enterprises } = await listRecords(ctx, 'enterprise', {
    category: filter.category,
    q: filter.q,
    acceptsLocalCredit: filter.acceptsLocalCredit,
    limit: 200,
  });

  const entries: DirectoryEntry[] = [];
  for (const enterprise of enterprises) {
    const [offers, needs] = await Promise.all([
      listRecords(ctx, 'offer', { enterpriseDid: enterprise.uri, limit: 200 }),
      listRecords(ctx, 'need', { enterpriseDid: enterprise.uri, limit: 200 }),
    ]);
    entries.push({
      uri: enterprise.uri,
      record: enterprise.record,
      offerCount: offers.rows.length,
      needCount: needs.rows.length,
    });
  }
  return entries;
}

// Re-exported for callers that want the raw enterprise rows too.
export type { RecordRow };
