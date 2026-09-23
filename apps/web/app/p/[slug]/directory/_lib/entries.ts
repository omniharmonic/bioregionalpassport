/** Shapes AppView directory entries for the Directory page (pure, unit-tested). */

export interface DirectoryCard {
  uri: string;
  anchor: string;
  name: string;
  categories: string[];
  description: string | null;
  address: string | null;
  acceptsCredits: boolean;
  /** Share of a sale the enterprise takes in credits (0–1), when it says. */
  acceptanceShare: number | null;
  offerCount: number;
  needCount: number;
  mappable: boolean;
}

export interface DirectoryQuery {
  q: string;
  category: string;
  credits: boolean;
}

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();

/** `?q=&category=&credits=1` → a clean query (length-capped). */
export function parseDirectoryQuery(sp: Record<string, string | string[] | undefined>): DirectoryQuery {
  const credits = first(sp['credits']);
  return { q: first(sp['q']).slice(0, 200), category: first(sp['category']).slice(0, 100), credits: credits === '1' || credits === 'true' || credits === 'on' };
}

export function anchorFor(uri: string): string {
  const tail = uri.split('/').pop() ?? uri;
  return `rec-${tail.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function toCard(e: { uri: string; record: Record<string, unknown>; offerCount: number; needCount: number }): DirectoryCard {
  const r = e.record;
  const share = typeof r['acceptanceShare'] === 'number' && Number.isFinite(r['acceptanceShare']) ? (r['acceptanceShare'] as number) : null;
  return {
    uri: e.uri,
    anchor: anchorFor(e.uri),
    name: str(r['name']) ?? 'An enterprise',
    categories: Array.isArray(r['categories']) ? r['categories'].filter((c): c is string => typeof c === 'string' && c.trim() !== '') : [],
    description: str(r['description']),
    address: str(r['address']),
    acceptsCredits: r['acceptsLocalCredit'] === true,
    acceptanceShare: share,
    offerCount: e.offerCount,
    needCount: e.needCount,
    mappable: typeof r['lat'] === 'number' && typeof r['lon'] === 'number',
  };
}

/** Every category named by any enterprise, sorted, for the filter menu. */
export function categoriesOf(records: { record: Record<string, unknown> }[]): string[] {
  const out = new Set<string>();
  for (const { record } of records) {
    if (Array.isArray(record['categories'])) for (const c of record['categories']) if (typeof c === 'string' && c.trim()) out.add(c.trim());
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
