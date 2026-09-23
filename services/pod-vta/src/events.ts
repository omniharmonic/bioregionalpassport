import { buildWitness, digestMultibase, randomNonce, type VerifiableCredential } from '@passport/credential-core';
import { EventAttestationDocumentSchema } from '@passport/lexicons';
import { ServiceError } from '@passport/service-kit';
import type { PodVtaDeps, VtaContext } from './types.js';
import { addDays, bad, isObject, json, toIso, toMs } from './util.js';

export const WITNESS_VALIDITY_DAYS = 365;
/** A convener may witness from one hour before the event starts until one day after it ends. */
export const WITNESS_EARLY_MS = 60 * 60_000;
export const WITNESS_LATE_MS = 24 * 60 * 60_000;

export interface EventInput {
  title: string;
  startsAt: string;
  endsAt: string;
  placeId?: string;
  lat?: number;
  lon?: number;
  description?: string;
}

export interface EventRow {
  id: string;
  title: string;
  starts_at: unknown;
  ends_at: unknown;
  place_id: string | null;
  conveners: unknown;
  task_document: unknown;
  task_digest: string | null;
  attestation: boolean;
}

export interface EventView {
  id: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  placeId: string | null;
  conveners: string[];
  attestation: boolean;
  taskDigest: string | null;
  taskDocument?: unknown;
}

export function eventView(row: EventRow, withDocument = false): EventView {
  return {
    id: row.id,
    title: row.title,
    startsAt: toIso(row.starts_at),
    endsAt: toIso(row.ends_at),
    placeId: row.place_id,
    conveners: json<string[]>(row.conveners) ?? [],
    attestation: row.attestation,
    taskDigest: row.task_digest,
    ...(withDocument ? { taskDocument: json(row.task_document) } : {}),
  };
}

function parseEventInput(body: unknown): EventInput {
  if (!isObject(body)) throw bad('BAD_REQUEST', 'The event needs a title, a start and an end.');
  const { title, startsAt, endsAt, placeId, lat, lon, description } = body;
  if (typeof title !== 'string' || !title.trim()) throw bad('BAD_REQUEST', 'The event needs a title.');
  const s = typeof startsAt === 'string' ? Date.parse(startsAt) : Number.NaN;
  const e = typeof endsAt === 'string' ? Date.parse(endsAt) : Number.NaN;
  if (Number.isNaN(s) || Number.isNaN(e)) throw bad('BAD_REQUEST', 'The event needs a start and an end as ISO dates.');
  if (e <= s) throw bad('BAD_REQUEST', 'The event must end after it starts.');
  if (placeId !== undefined && (typeof placeId !== 'string' || !placeId)) throw bad('BAD_REQUEST', 'placeId must be a non-empty string.');
  if (lat !== undefined && (typeof lat !== 'number' || lat < -90 || lat > 90)) throw bad('BAD_REQUEST', 'lat must be a latitude.');
  if (lon !== undefined && (typeof lon !== 'number' || lon < -180 || lon > 180)) throw bad('BAD_REQUEST', 'lon must be a longitude.');
  if (description !== undefined && typeof description !== 'string') throw bad('BAD_REQUEST', 'description must be text.');
  return {
    title: title.trim(),
    startsAt: new Date(s).toISOString(),
    endsAt: new Date(e).toISOString(),
    ...(placeId !== undefined ? { placeId } : {}),
    ...(lat !== undefined ? { lat } : {}),
    ...(lon !== undefined ? { lon } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

/**
 * Creates an attestation event and its `org.bioregion.event.attestation` Trust Task document (B3 §5), signed by
 * the pod so conveners and members can check it. `taskDigest = digestMultibase(taskDocument)` (over the signed
 * document) is what every VWC from this event carries as `taskDigestMultibase`. The optional `description` rides
 * in the task document (the `events` table has no column for it).
 */
export async function createEvent(ctx: VtaContext, deps: Pick<PodVtaDeps, 'podSigner'>, convener: string, body: unknown): Promise<EventView> {
  const input = parseEventInput(body);
  const id = `evt_${randomNonce(12)}`;
  const now = ctx.now().toISOString();
  const location = {
    ...(input.placeId ? { placeId: input.placeId } : {}),
    ...(input.lat !== undefined ? { lat: input.lat } : {}),
    ...(input.lon !== undefined ? { lon: input.lon } : {}),
    name: input.title,
  };
  const unsigned = {
    type: 'org.bioregion.event.attestation' as const,
    createdAt: now,
    seq: 0,
    id,
    pod: ctx.podDid,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    conveners: [convener],
    location,
    ...(input.description ? { description: input.description } : {}),
  };
  EventAttestationDocumentSchema.parse(unsigned);
  const taskDocument = deps.podSigner.sign(unsigned, { created: now });
  const taskDigest = digestMultibase(taskDocument);
  const [row] = await ctx.db.query<EventRow>(
    `INSERT INTO events (id, title, starts_at, ends_at, place_id, conveners, task_document, task_digest, attestation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true) RETURNING *`,
    [id, input.title, input.startsAt, input.endsAt, input.placeId ?? null, JSON.stringify([convener]), JSON.stringify(taskDocument), taskDigest],
  );
  return eventView(row!, true);
}

/** Public list: upcoming and ongoing events first (soonest first), then past events (most recent first). */
export async function listEvents(ctx: VtaContext): Promise<EventView[]> {
  const rows = await ctx.db.query<EventRow>(
    `SELECT * FROM events
      ORDER BY (ends_at < $1) ASC,
               CASE WHEN ends_at >= $1 THEN starts_at END ASC,
               CASE WHEN ends_at < $1 THEN starts_at END DESC`,
    [ctx.now().toISOString()],
  );
  return rows.map((r) => eventView(r));
}

export async function getEventRow(ctx: VtaContext, id: string): Promise<EventRow | undefined> {
  const rows = await ctx.db.query<EventRow>('SELECT * FROM events WHERE id = $1', [id]);
  return rows[0];
}

export async function getEvent(ctx: VtaContext, id: string): Promise<EventView> {
  const row = await getEventRow(ctx, id);
  if (!row) throw new ServiceError(404, 'NOT_FOUND', 'There is no event with that id in this pod.');
  return eventView(row, true);
}

/**
 * Issues a witness credential (VWC, StatementCredential `dtg:witnessed`) for an edge at an attestation event.
 *
 * Ruling: the VWC is issued BY THE POD VTA on behalf of the convener — `issuer = ctx.podDid`,
 * `credentialSubject.witnessedBy = <convener DID>`. The server does not hold the convener's key (it lives in
 * their wallet) and the wallet does not hold the pod key, so the pod signs after checking the convener's session
 * carries `vwc:issue` and names them among the event's conveners. Convener-signed VWCs are the DIDComm follow-up.
 */
export async function witnessEdge(
  ctx: VtaContext,
  deps: Pick<PodVtaDeps, 'podSigner'>,
  convener: string,
  eventId: string,
  body: unknown,
): Promise<{ vwc: VerifiableCredential }> {
  if (!isObject(body)) throw bad('BAD_REQUEST', 'A witness request needs an edge digest and evidence.');
  const { edgeDigest, evidence, subject } = body;
  if (typeof edgeDigest !== 'string' || !edgeDigest.startsWith('z')) throw bad('BAD_REQUEST', 'edgeDigest must be a multibase digest (z…).');
  if (evidence !== 'same-event' && evidence !== 'liveness') throw bad('BAD_REQUEST', 'evidence must be same-event or liveness.');
  if (subject !== undefined && (typeof subject !== 'string' || !subject.startsWith('did:'))) throw bad('BAD_REQUEST', 'subject must be a DID.');
  const row = await getEventRow(ctx, eventId);
  if (!row) throw new ServiceError(404, 'NOT_FOUND', 'There is no event with that id in this pod.');
  if (!row.attestation || !row.task_digest) throw new ServiceError(409, 'NOT_ATTESTATION_EVENT', 'This event is not an attestation event, so it cannot witness relationships.');
  const conveners = json<string[]>(row.conveners) ?? [];
  if (!conveners.includes(convener)) throw new ServiceError(403, 'NOT_CONVENER', 'Only a convener of this event can witness at it.');
  const now = ctx.now();
  const t = now.getTime();
  if (t < toMs(row.starts_at) - WITNESS_EARLY_MS || t > toMs(row.ends_at) + WITNESS_LATE_MS) {
    throw new ServiceError(409, 'EVENT_NOT_ACTIVE', 'Witnessing is only possible while the event is happening.');
  }
  const unsigned = buildWitness({
    issuer: ctx.podDid,
    edgeDigest,
    taskContext: row.id,
    taskDigest: row.task_digest,
    evidence,
    validFrom: now.toISOString(),
    validUntil: addDays(now, WITNESS_VALIDITY_DAYS),
    ...(subject ? { subject } : {}),
  });
  unsigned.credentialSubject['witnessedBy'] = convener;
  const vwc = deps.podSigner.sign(unsigned, { created: now.toISOString() });
  await ctx.db.query('INSERT INTO witness_refs (digest, event_id, convener_did, created_at) VALUES ($1, $2, $3, $4)', [
    digestMultibase(vwc),
    row.id,
    convener,
    now.toISOString(),
  ]);
  return { vwc };
}
