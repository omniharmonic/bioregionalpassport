/**
 * The Events page lists two sources (issue 3 of the MVP e2e report):
 * - attestation events a steward convened through the pod VTA (`events` table), and
 * - `event` open records in the AppView (the demo seeds and anything members publish).
 * They are merged, de-duplicated by title + start time, and sorted by start (undated last).
 */

export interface GatheringView {
  /** Stable key (and page anchor). */
  key: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  attestation: boolean;
  description: string | null;
  location: string | null;
  conveners: number;
  /** Which sources listed it. */
  sources: ('vta' | 'record')[];
  /** AppView record URI, when the gathering is an open record. */
  uri: string | null;
  /** The record has coordinates, so it shows on the map. */
  mappable: boolean;
}

export interface VtaEventRow {
  id: string;
  title: string;
  starts_at: string | Date | null;
  ends_at: string | Date | null;
  place_id: string | null;
  conveners: unknown;
  attestation: boolean;
}

export interface EventRecordRow {
  uri: string;
  record: Record<string, unknown>;
}

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Last path segment of an `at://` URI, safe for an element id. */
export function anchorFor(uri: string): string {
  const tail = uri.split('/').pop() ?? uri;
  return `rec-${tail.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

const dedupeKey = (title: string, startsAt: string | null) => `${title.trim().toLowerCase()}|${startsAt ?? ''}`;

export function fromVta(e: VtaEventRow): GatheringView {
  return {
    key: `evt-${e.id.replace(/[^A-Za-z0-9_-]/g, '')}`,
    title: e.title,
    startsAt: iso(e.starts_at),
    endsAt: iso(e.ends_at),
    attestation: Boolean(e.attestation),
    description: null,
    location: e.place_id,
    conveners: Array.isArray(e.conveners) ? e.conveners.length : 0,
    sources: ['vta'],
    uri: null,
    mappable: false,
  };
}

export function fromRecord(row: EventRecordRow): GatheringView | null {
  const r = row.record;
  const title = str(r['title']);
  if (!title) return null;
  const loc = r['location'];
  const locName = loc && typeof loc === 'object' ? str((loc as Record<string, unknown>)['name']) : null;
  return {
    key: anchorFor(row.uri),
    title,
    startsAt: iso(r['startsAt']),
    endsAt: iso(r['endsAt']),
    attestation: r['attestation'] === true,
    description: str(r['description']),
    location: locName ?? str(r['address']),
    conveners: Array.isArray(r['conveners']) ? r['conveners'].length : 0,
    sources: ['record'],
    uri: row.uri,
    mappable: typeof r['lat'] === 'number' && typeof r['lon'] === 'number',
  };
}

/** A gathering is still listed until a day after it ends (or starts, when no end is given). */
export function isCurrent(g: GatheringView, now: Date): boolean {
  const last = g.endsAt ?? g.startsAt;
  if (!last) return true;
  return Date.parse(last) > now.getTime() - 24 * 60 * 60 * 1000;
}

/** Merges both sources; a duplicate keeps the VTA event and fills in the record's description and place. */
export function mergeGatherings(vta: VtaEventRow[], records: EventRecordRow[], now: Date = new Date()): GatheringView[] {
  const byKey = new Map<string, GatheringView>();
  for (const g of vta.map(fromVta)) byKey.set(dedupeKey(g.title, g.startsAt), g);
  for (const g of records.map(fromRecord)) {
    if (!g) continue;
    const k = dedupeKey(g.title, g.startsAt);
    const prior = byKey.get(k);
    if (!prior) {
      byKey.set(k, g);
      continue;
    }
    byKey.set(k, {
      ...prior,
      attestation: prior.attestation || g.attestation,
      description: prior.description ?? g.description,
      location: g.location ?? prior.location,
      endsAt: prior.endsAt ?? g.endsAt,
      conveners: Math.max(prior.conveners, g.conveners),
      sources: [...prior.sources, 'record'],
      uri: g.uri,
      mappable: g.mappable,
    });
  }
  return [...byKey.values()]
    .filter((g) => isCurrent(g, now))
    .sort((a, b) => {
      if (a.startsAt === b.startsAt) return a.title.localeCompare(b.title);
      if (a.startsAt === null) return 1;
      if (b.startsAt === null) return -1;
      return Date.parse(a.startsAt) - Date.parse(b.startsAt);
    });
}
