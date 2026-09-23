/**
 * Storage layer for open records (MVP plan §5 Task 10, ADR-24).
 *
 * Every collection except `offer`/`need` is stored in the pod's `records`
 * table (`uri` primary key, `org.bioregion.<collection>/<rkey>` shape).
 * `offer` and `need` are Valueflows resource-flow records; `packages/db`'s
 * pod schema stores those in the dedicated `offers` table (`kind` column
 * distinguishes the two) rather than `records`, so the ledger/matching code
 * that will read `offers` later doesn't have to filter by collection. This
 * module exposes both through the same `listRecords`/`getRecord`/`putRecord`
 * API so callers never need to know which table backs a collection — see
 * `isOfferLike` below for the routing rule. Because `offers` has no
 * `author_did`/`created_at`/`updated_at` columns, those are folded into its
 * `record` jsonb blob (`authorDid`) and stripped back out on read.
 */
import { RECORD_SCHEMAS, recordUri, parseRecordUri, type Collection } from '@passport/lexicons';
import { isAtLeast, TIERS, type Tier } from '@passport/vocab';
import { ServiceError, type PodContext, type SessionClaims } from './kit.js';
import { generateTid } from './tid.js';

export interface RecordRow {
  uri: string;
  collection: Collection;
  rkey: string;
  bioregion: string;
  placeId?: string;
  authorDid?: string;
  record: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface RecordFilter {
  /** Case-insensitive substring match across the record's name/title/description. */
  q?: string;
  /** `enterprise` collection only: match a category tag. */
  category?: string;
  /** `enterprise` collection only. */
  acceptsLocalCredit?: boolean;
  /** `offer`/`need` collections only: the enterprise's record uri. */
  enterpriseDid?: string;
  limit?: number;
  /**
   * Keyset pagination cursor: opaque to clients — pass back exactly the
   * `nextCursor` a previous `listRecords` call returned (the last row's
   * `uri`, in its `at://<slug>/org.bioregion.<collection>/<rkey>` form, for
   * every collection including `offer`/`need`).
   */
  cursor?: string;
}

export interface RecordPage {
  rows: RecordRow[];
  /** The `uri` to pass as `cursor` for the next page, or `null` if this was the last page. */
  nextCursor: string | null;
}

const OFFER_LIKE = new Set<string>(['offer', 'need']);

function isOfferLike(collection: Collection): boolean {
  return OFFER_LIKE.has(collection);
}

export function assertCollection(collection: string): Collection {
  if (!(collection in RECORD_SCHEMAS)) {
    throw new ServiceError(
      400,
      'UNKNOWN_COLLECTION',
      `"${collection}" isn't a record collection this pod serves.`,
    );
  }
  return collection as Collection;
}

function asJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** Escapes `\`, `%`, and `_` so a user-supplied substring is safe to interpolate into an `ILIKE '%…%'` pattern. */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, '\\$&');
}

/**
 * The `offers` table's PK is a bare `rkey` (its `uri` is derived, not
 * stored), so a `cursor` for `offer`/`need` — which is always the row's
 * full `uri` — has to be unwrapped back to that `rkey` before it can be
 * compared against `id`.
 */
function cursorToOfferRkey(ctx: { slug: string }, collection: Collection, cursor: string): string {
  try {
    const parsed = parseRecordUri(cursor);
    if (parsed.slug !== ctx.slug || parsed.collection !== collection) {
      throw new Error('cursor collection/pod mismatch');
    }
    return parsed.rkey;
  } catch {
    throw new ServiceError(400, 'INVALID_CURSOR', 'That pagination cursor is not valid for this collection.');
  }
}

export function mapRecordsRow(row: any): RecordRow {
  const { rkey } = parseRecordUri(row.uri);
  return {
    uri: row.uri,
    collection: row.collection,
    rkey,
    bioregion: row.bioregion,
    placeId: row.place_id ?? undefined,
    authorDid: row.author_did ?? undefined,
    record: asJson(row.record) as Record<string, unknown>,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
  };
}

function mapOfferRow(slug: string, collection: Collection, row: any): RecordRow {
  const stored = (asJson(row.record) as Record<string, unknown>) ?? {};
  const { authorDid, ...record } = stored as { authorDid?: string; [k: string]: unknown };
  return {
    uri: recordUri(slug, collection, row.id),
    collection,
    rkey: row.id,
    bioregion: (record.bioregion as string) ?? slug,
    placeId: (record.placeId as string | undefined) ?? undefined,
    authorDid,
    record,
  };
}

export async function listRecords(
  ctx: PodContext,
  collection: string,
  filter: RecordFilter = {},
): Promise<RecordPage> {
  const col = assertCollection(collection);
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);

  if (isOfferLike(col)) {
    const conditions: string[] = ['kind = $1'];
    const params: unknown[] = [col];
    if (filter.enterpriseDid) {
      params.push(filter.enterpriseDid);
      conditions.push(`enterprise_did = $${params.length}`);
    }
    if (filter.q) {
      params.push(`%${escapeLike(filter.q)}%`);
      const idx = params.length;
      conditions.push(
        `(record ->> 'resourceSpec' ILIKE $${idx} ESCAPE '\\' OR record ->> 'description' ILIKE $${idx} ESCAPE '\\')`,
      );
    }
    if (filter.cursor) {
      params.push(cursorToOfferRkey(ctx, col, filter.cursor));
      conditions.push(`id > $${params.length}`);
    }
    params.push(limit);
    const rows = await ctx.db.query(
      `SELECT id, enterprise_did, kind, record FROM offers WHERE ${conditions.join(' AND ')} ORDER BY id ASC LIMIT $${params.length}`,
      params,
    );
    const mapped = rows.map((row) => mapOfferRow(ctx.slug, col, row));
    const last = mapped.length === limit ? mapped[mapped.length - 1] : undefined;
    return { rows: mapped, nextCursor: last ? last.uri : null };
  }

  const conditions: string[] = ['collection = $1'];
  const params: unknown[] = [col];
  if (filter.q) {
    params.push(`%${escapeLike(filter.q)}%`);
    const idx = params.length;
    conditions.push(
      `(record ->> 'name' ILIKE $${idx} ESCAPE '\\' OR record ->> 'title' ILIKE $${idx} ESCAPE '\\' OR record ->> 'description' ILIKE $${idx} ESCAPE '\\')`,
    );
  }
  if (filter.category) {
    params.push(filter.category);
    conditions.push(`record -> 'categories' ? $${params.length}`);
  }
  if (filter.acceptsLocalCredit !== undefined) {
    params.push(filter.acceptsLocalCredit);
    conditions.push(`(record ->> 'acceptsLocalCredit')::boolean = $${params.length}`);
  }
  if (filter.cursor) {
    // The cursor is the previous page's last `uri`; `uri`'s ordering matches
    // `rkey`'s ordering for a fixed slug+collection prefix, so comparing the
    // full uri keeps keyset pagination correct without unwrapping it.
    params.push(filter.cursor);
    conditions.push(`uri > $${params.length}`);
  }
  params.push(limit);
  const rows = await ctx.db.query(
    `SELECT uri, collection, bioregion, place_id, author_did, record, created_at, updated_at
       FROM records WHERE ${conditions.join(' AND ')} ORDER BY uri ASC LIMIT $${params.length}`,
    params,
  );
  const mapped = rows.map(mapRecordsRow);
  const last = mapped.length === limit ? mapped[mapped.length - 1] : undefined;
  return { rows: mapped, nextCursor: last ? last.uri : null };
}

export async function getRecord(
  ctx: PodContext,
  collection: string,
  rkey: string,
): Promise<RecordRow | null> {
  const col = assertCollection(collection);

  if (isOfferLike(col)) {
    const rows = await ctx.db.query(
      'SELECT id, enterprise_did, kind, record FROM offers WHERE id = $1 AND kind = $2',
      [rkey, col],
    );
    return rows[0] ? mapOfferRow(ctx.slug, col, rows[0]) : null;
  }

  const uri = recordUri(ctx.slug, col, rkey);
  const rows = await ctx.db.query(
    'SELECT uri, collection, bioregion, place_id, author_did, record, created_at, updated_at FROM records WHERE uri = $1',
    [uri],
  );
  return rows[0] ? mapRecordsRow(rows[0]) : null;
}

function tierOf(session: SessionClaims): Tier {
  const tier = session.tier;
  return tier && (TIERS as readonly string[]).includes(tier) ? (tier as Tier) : 'T0';
}

/**
 * Creates or replaces a record. `rkey` is the caller-supplied key for a
 * `PUT` (author-only once the record exists); pass `undefined` for a `POST`,
 * which generates a fresh sortable key. `bioregion` is always forced to
 * `ctx.slug`; a body naming a different bioregion is refused with
 * `POD_MISMATCH`. Creating an `enterprise` requires at least tier T1.
 */
export async function putRecord(
  ctx: PodContext,
  collection: string,
  rkey: string | undefined,
  body: unknown,
  session: SessionClaims,
): Promise<RecordRow> {
  const col = assertCollection(collection);

  const providedBioregion = (body as Record<string, unknown> | null | undefined)?.bioregion;
  if (providedBioregion !== undefined && providedBioregion !== ctx.slug) {
    throw new ServiceError(
      400,
      'POD_MISMATCH',
      'This record names a different bioregion than this pod.',
    );
  }

  const schema = RECORD_SCHEMAS[col];
  const candidate = { ...(body as Record<string, unknown>), bioregion: ctx.slug };
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ServiceError(400, 'INVALID_RECORD', `Record doesn't match its schema: ${issues.join('; ')}`);
  }

  if (col === 'enterprise' && !isAtLeast(tierOf(session), 'T1')) {
    throw new ServiceError(
      403,
      'TIER_TOO_LOW',
      'Listing an enterprise needs at least a Member (T1) passport.',
    );
  }

  const finalRkey = rkey ?? generateTid(ctx.now);
  const existing = await getRecord(ctx, col, finalRkey);
  if (existing && existing.authorDid && existing.authorDid !== session.subject) {
    throw new ServiceError(403, 'NOT_AUTHOR', 'Only the author of this record may change it.');
  }

  const data = parsed.data as Record<string, unknown>;
  const authorDid = session.subject;

  if (isOfferLike(col)) {
    const enterpriseDid = typeof data.enterprise === 'string' ? data.enterprise : null;
    const record = JSON.stringify({ ...data, authorDid });
    await ctx.db.query(
      `INSERT INTO offers (id, enterprise_did, kind, record) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (id) DO UPDATE SET enterprise_did = excluded.enterprise_did, record = excluded.record`,
      [finalRkey, enterpriseDid, col, record],
    );
    return (await getRecord(ctx, col, finalRkey))!;
  }

  const uri = recordUri(ctx.slug, col, finalRkey);
  const placeId = typeof data.placeId === 'string' ? data.placeId : null;
  const record = JSON.stringify(data);
  await ctx.db.query(
    `INSERT INTO records (uri, collection, bioregion, place_id, author_did, record, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, now(), now())
     ON CONFLICT (uri) DO UPDATE SET
       place_id = excluded.place_id, record = excluded.record, updated_at = now()`,
    [uri, col, ctx.slug, placeId, authorDid, record],
  );
  return (await getRecord(ctx, col, finalRkey))!;
}

/** Deletes a record; only its author may delete it (`NOT_AUTHOR` 403 otherwise). */
export async function deleteRecord(
  ctx: PodContext,
  collection: string,
  rkey: string,
  session: SessionClaims,
): Promise<void> {
  const col = assertCollection(collection);
  const existing = await getRecord(ctx, col, rkey);
  if (!existing) {
    throw new ServiceError(404, 'NOT_FOUND', 'No record exists at that key.');
  }
  if (existing.authorDid !== session.subject) {
    throw new ServiceError(403, 'NOT_AUTHOR', 'Only the author of this record may delete it.');
  }

  if (isOfferLike(col)) {
    await ctx.db.query('DELETE FROM offers WHERE id = $1 AND kind = $2', [rkey, col]);
    return;
  }
  const uri = recordUri(ctx.slug, col, rkey);
  await ctx.db.query('DELETE FROM records WHERE uri = $1', [uri]);
}

/** True when this pod has no open records at all (used to gate `seedDemoRecords`). */
export async function hasAnyRecords(ctx: PodContext): Promise<boolean> {
  const [recordsRow] = await ctx.db.query<{ count: string }>('SELECT count(*)::text AS count FROM records');
  if (recordsRow && Number(recordsRow.count) > 0) return true;
  const [offersRow] = await ctx.db.query<{ count: string }>('SELECT count(*)::text AS count FROM offers');
  return Boolean(offersRow && Number(offersRow.count) > 0);
}
