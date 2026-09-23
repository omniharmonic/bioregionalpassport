import { buildWitness, digestMultibase, randomNonce, type VerifiableCredential } from '@passport/credential-core';
import { EventAttestationDocumentSchema } from '@passport/lexicons';
import { ServiceError } from '@passport/service-kit';
import { checkVrcPair } from './edges.js';
import type { PodVtaDeps, VtaContext } from './types.js';
import { addDays, bad, isObject, json, toIso, toMs } from './util.js';

export const WITNESS_VALIDITY_DAYS = 365;
export const SMOKE_PREFIX = 'smoke-';

const alreadyWitnessed = () => new ServiceError(409, 'ALREADY_WITNESSED', 'This relationship has already been witnessed in this pod.');

/** An event that may witness: a real attestation event, or the provisioning smoke's own event. */
export const canWitnessAt = (row: { id: string; attestation: boolean; task_digest: string | null }): boolean =>
  !!row.task_digest && (row.attestation || row.id.startsWith(SMOKE_PREFIX));
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
    taskDigest: row.task_digest!,
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
export async function createEvent(
  ctx: VtaContext,
  deps: Pick<PodVtaDeps, 'podSigner'>,
  convener: string,
  body: unknown,
  opts: { smoke?: boolean } = {},
): Promise<EventView> {
  const input = parseEventInput(body);
  // Smoke events (in-process provisioning check only; never reachable from a route) are `smoke-` prefixed,
  // not attestation events, hidden from listings, and deleted by the smoke before it returns.
  const id = opts.smoke ? `${SMOKE_PREFIX}evt_${randomNonce(12)}` : `evt_${randomNonce(12)}`;
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
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [id, input.title, input.startsAt, input.endsAt, input.placeId ?? null, JSON.stringify([convener]), JSON.stringify(taskDocument), taskDigest, !opts.smoke],
  );
  return eventView(row!, true);
}

/** Public list: upcoming and ongoing events first (soonest first), then past events (most recent first). */
export async function listEvents(ctx: VtaContext): Promise<EventView[]> {
  const rows = await ctx.db.query<EventRow>(
    `SELECT * FROM events
      WHERE id NOT LIKE 'smoke-%'
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
 * For an already-witnessed pair: the same convener gets the stored VWC back (lost-response recovery, marked
 * `existing: true`); anyone else gets 409 `ALREADY_WITNESSED`. Returns undefined when the pair is new.
 */
async function existingWitness(ctx: VtaContext, pairDigest: string, convener: string): Promise<{ vwc: VerifiableCredential; existing: true } | undefined> {
  const [ref] = await ctx.db.query<{ digest: string; convener_did: string | null }>(
    'SELECT digest, convener_did FROM witness_refs WHERE pair_digest = $1',
    [pairDigest],
  );
  if (!ref) return undefined;
  if (ref.convener_did === convener) {
    const [stored] = await ctx.db.query<{ vwc: unknown }>('SELECT vwc FROM vta_witness_credentials WHERE digest = $1', [ref.digest]);
    if (stored) return { vwc: json<VerifiableCredential>(stored.vwc), existing: true };
  }
  throw alreadyWitnessed();
}

/**
 * Issues a witness credential (VWC, StatementCredential `dtg:witnessed`) for an edge at an attestation event.
 *
 * The witnessed edge is the VRC PAIR: the body carries both signed halves `{ vrcA, vrcB, evidence, subject? }`;
 * both proofs are verified, the halves must mirror each other between two distinct DIDs, and the server derives
 * `edgeParties = [vrcA.issuer, vrcB.issuer]` and `edgeDigest = edgePairDigest(vrcA, vrcB)` (see edges.ts), so
 * both people must have signed.
 *
 * Ruling: the VWC is issued BY THE POD VTA on behalf of the convener — `issuer = ctx.podDid`,
 * `credentialSubject.witnessedBy = <convener DID>`. The server does not hold the convener's key (it lives in
 * their wallet) and the wallet does not hold the pod key, so the pod signs after checking the convener's session
 * carries `vwc:issue` and names them among the event's conveners. Convener-signed VWCs are the DIDComm follow-up.
 */
export async function witnessEdge(
  ctx: VtaContext,
  deps: Pick<PodVtaDeps, 'podSigner' | 'resolver'>,
  convener: string,
  eventId: string,
  body: unknown,
): Promise<{ vwc: VerifiableCredential; existing?: true }> {
  if (!isObject(body)) throw bad('BAD_REQUEST', 'A witness request needs both relationship halves and evidence.');
  const { vrcA, vrcB, evidence, subject } = body;
  if (evidence !== 'same-event' && evidence !== 'liveness') throw bad('BAD_REQUEST', 'evidence must be same-event or liveness.');
  const pair = await checkVrcPair(vrcA, vrcB, deps.resolver);
  if (!pair.ok) throw bad('BAD_PAIR', `A witness request needs both signed halves of one relationship: ${pair.reason}`);
  const edgeParties = pair.parties;
  if (subject !== undefined && (typeof subject !== 'string' || !edgeParties.includes(subject))) {
    throw bad('BAD_REQUEST', 'subject must be one of the two people in the relationship.');
  }
  const row = await getEventRow(ctx, eventId);
  if (!row) throw new ServiceError(404, 'NOT_FOUND', 'There is no event with that id in this pod.');
  if (!canWitnessAt(row)) throw new ServiceError(409, 'NOT_ATTESTATION_EVENT', 'This event is not an attestation event, so it cannot witness relationships.');
  const conveners = json<string[]>(row.conveners) ?? [];
  if (!conveners.includes(convener)) throw new ServiceError(403, 'NOT_CONVENER', 'Only a convener of this event can witness at it.');
  // A relationship is witnessed at most once per pod (else the index would count it as several edges/events).
  if (edgeParties.includes(convener)) {
    throw new ServiceError(403, 'SELF_WITNESS', 'A convener cannot witness their own relationship.');
  }
  const recovered = await existingWitness(ctx, pair.digest, convener);
  if (recovered) return recovered;
  const now = ctx.now();
  const t = now.getTime();
  if (t < toMs(row.starts_at) - WITNESS_EARLY_MS || t > toMs(row.ends_at) + WITNESS_LATE_MS) {
    throw new ServiceError(409, 'EVENT_NOT_ACTIVE', 'Witnessing is only possible while the event is happening.');
  }
  const unsigned = buildWitness({
    issuer: ctx.podDid,
    edgeDigest: pair.digest,
    taskContext: row.id,
    taskDigest: row.task_digest!,
    evidence,
    validFrom: now.toISOString(),
    validUntil: addDays(now, WITNESS_VALIDITY_DAYS),
    ...(typeof subject === 'string' ? { subject } : {}),
  });
  unsigned.credentialSubject['witnessedBy'] = convener;
  unsigned.credentialSubject['edgeParties'] = [edgeParties[0], edgeParties[1]];
  const vwc = deps.podSigner.sign(unsigned, { created: now.toISOString() });
  // The unique index on pair_digest (migration 0009_witness_pair.sql) also closes the race between two concurrent requests.
  const inserted = await ctx.db.query(
    `INSERT INTO witness_refs (digest, event_id, convener_did, created_at, pair_digest) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING RETURNING digest`,
    [digestMultibase(vwc), row.id, convener, now.toISOString(), pair.digest],
  );
  if (!inserted.length) {
    const again = await existingWitness(ctx, pair.digest, convener);
    if (again) return again;
    throw alreadyWitnessed();
  }
  await ctx.db.query('INSERT INTO vta_witness_credentials (digest, vwc) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
    digestMultibase(vwc),
    JSON.stringify(vwc),
  ]);
  return { vwc };
}
