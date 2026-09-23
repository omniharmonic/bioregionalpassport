import { buildWitness, digestMultibase, randomNonce, type VerifiableCredential } from '@passport/credential-core';
import { EventAttestationDocumentSchema } from '@passport/lexicons';
import { ServiceError } from '@passport/service-kit';
import { checkVrcPair } from './edges.js';
import type { PodVtaDeps, VtaContext } from './types.js';
import { TIERS, type Tier } from '@passport/vocab';
import { addDays, bad, isObject, json, tid, toIso, toMs } from './util.js';

export const WITNESS_VALIDITY_DAYS = 365;
export const SMOKE_PREFIX = 'smoke-';
/** Ad-hoc Trust Tasks created by `POST /witness` (a meeting witnessed without a scheduled event). */
export const MEETING_PREFIX = 'meet-';
/** A meeting Trust Task spans one hour from the moment it was witnessed. */
export const MEETING_DURATION_MS = 60 * 60_000;
/** `events.kind` (migration 0011): scheduled gatherings, or ad-hoc meetings created by a witness. */
export type EventKind = 'event' | 'meeting';

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
  /** Migration 0011; null/absent on rows from before it (= 'event'). */
  kind?: string | null;
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
  kind: EventKind;
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
    kind: row.kind === 'meeting' ? 'meeting' : 'event',
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

/**
 * Public list: upcoming and ongoing events first (soonest first), then past events (most recent first).
 * Meetings (`kind = 'meeting'`, ad-hoc Trust Tasks from `POST /witness`) are not gatherings people attend, so
 * they are excluded unless `kind: 'meeting'` is asked for (a steward view; the route gates it on `pep:review`).
 */
export async function listEvents(ctx: VtaContext, opts: { kind?: EventKind } = {}): Promise<EventView[]> {
  const kindClause = opts.kind === 'meeting' ? `kind = 'meeting'` : `COALESCE(kind, 'event') <> 'meeting'`;
  const rows = await ctx.db.query<EventRow>(
    `SELECT * FROM events
      WHERE id NOT LIKE 'smoke-%' AND ${kindClause}
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

/** A parsed witness request: both halves verified as one mirrored pair between two distinct DIDs. */
interface WitnessRequest {
  pair: { digest: string; parties: [string, string] };
  evidence: 'same-event' | 'liveness';
  subject?: string;
}

async function parseWitnessRequest(deps: Pick<PodVtaDeps, 'resolver'>, body: unknown): Promise<WitnessRequest> {
  if (!isObject(body)) throw bad('BAD_REQUEST', 'A witness request needs both relationship halves and evidence.');
  const { vrcA, vrcB, evidence, subject } = body;
  if (evidence !== 'same-event' && evidence !== 'liveness') throw bad('BAD_REQUEST', 'evidence must be same-event or liveness.');
  const pair = await checkVrcPair(vrcA, vrcB, deps.resolver);
  if (!pair.ok) throw bad('BAD_PAIR', `A witness request needs both signed halves of one relationship: ${pair.reason}`);
  const parties: [string, string] = [pair.parties[0]!, pair.parties[1]!];
  if (subject !== undefined && (typeof subject !== 'string' || !parties.includes(subject))) {
    throw bad('BAD_REQUEST', 'subject must be one of the two people in the relationship.');
  }
  return { pair: { digest: pair.digest, parties }, evidence, ...(typeof subject === 'string' ? { subject } : {}) };
}

/** No one witnesses their own relationship. */
function refuseSelfWitness(req: WitnessRequest, witness: string, role: 'convener' | 'witness'): void {
  if (req.pair.parties.includes(witness)) {
    throw new ServiceError(403, 'SELF_WITNESS', `A ${role} cannot witness their own relationship.`);
  }
}

/** The witness's governance-or-effective tier right now (`GREATEST(tier, effective_tier)`), or null for a non-member. */
async function witnessTierNow(ctx: VtaContext, witness: string): Promise<Tier | null> {
  const [row] = await ctx.db.query<{ t: string | null }>('SELECT GREATEST(tier, effective_tier) AS t FROM members WHERE did = $1', [witness]);
  return row?.t && (TIERS as readonly string[]).includes(row.t) ? (row.t as Tier) : null;
}

/**
 * The shared pair-witness step, after the caller has checked where the witnessing happened: builds the VWC
 * bound to the Trust Task `row` (`taskContext = row.id`, `taskDigestMultibase = row.task_digest`), records it in
 * `witness_refs` (with the witness's tier at witness time, migration 0011) and `vta_witness_credentials`.
 */
async function issueWitness(
  ctx: VtaContext,
  deps: Pick<PodVtaDeps, 'podSigner'>,
  witness: string,
  row: EventRow,
  req: WitnessRequest,
): Promise<{ vwc: VerifiableCredential; existing?: true }> {
  const now = ctx.now();
  const unsigned = buildWitness({
    issuer: ctx.podDid,
    edgeDigest: req.pair.digest,
    taskContext: row.id,
    taskDigest: row.task_digest!,
    evidence: req.evidence,
    validFrom: now.toISOString(),
    validUntil: addDays(now, WITNESS_VALIDITY_DAYS),
    ...(req.subject ? { subject: req.subject } : {}),
  });
  unsigned.credentialSubject['witnessedBy'] = witness;
  unsigned.credentialSubject['edgeParties'] = [req.pair.parties[0], req.pair.parties[1]];
  const vwc = deps.podSigner.sign(unsigned, { created: now.toISOString() });
  const tier = await witnessTierNow(ctx, witness);
  // The unique index on pair_digest (migration 0009_witness_pair.sql) also closes the race between two concurrent requests.
  const inserted = await ctx.db.query(
    `INSERT INTO witness_refs (digest, event_id, convener_did, created_at, pair_digest, witness_tier) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING RETURNING digest`,
    [digestMultibase(vwc), row.id, witness, now.toISOString(), req.pair.digest, tier],
  );
  if (!inserted.length) {
    const again = await existingWitness(ctx, req.pair.digest, witness);
    if (again) return again;
    throw alreadyWitnessed();
  }
  await ctx.db.query('INSERT INTO vta_witness_credentials (digest, vwc) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
    digestMultibase(vwc),
    JSON.stringify(vwc),
  ]);
  return { vwc };
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
  const req = await parseWitnessRequest(deps, body);
  const row = await getEventRow(ctx, eventId);
  if (!row) throw new ServiceError(404, 'NOT_FOUND', 'There is no event with that id in this pod.');
  if (!canWitnessAt(row)) throw new ServiceError(409, 'NOT_ATTESTATION_EVENT', 'This event is not an attestation event, so it cannot witness relationships.');
  const conveners = json<string[]>(row.conveners) ?? [];
  if (!conveners.includes(convener)) throw new ServiceError(403, 'NOT_CONVENER', 'Only a convener of this event can witness at it.');
  refuseSelfWitness(req, convener, 'convener');
  // A relationship is witnessed at most once per pod (else the index would count it as several edges/events).
  const recovered = await existingWitness(ctx, req.pair.digest, convener);
  if (recovered) return recovered;
  const t = ctx.now().getTime();
  if (t < toMs(row.starts_at) - WITNESS_EARLY_MS || t > toMs(row.ends_at) + WITNESS_LATE_MS) {
    throw new ServiceError(409, 'EVENT_NOT_ACTIVE', 'Witnessing is only possible while the event is happening.');
  }
  return issueWitness(ctx, deps, convener, row, req);
}

export interface MeetingPlace {
  placeId?: string;
  lat?: number;
  lon?: number;
  name?: string;
}

function parsePlace(v: unknown): MeetingPlace {
  if (v === undefined || v === null) return {};
  if (!isObject(v)) throw bad('BAD_REQUEST', 'place must be an object with placeId, lat, lon or name.');
  const { placeId, lat, lon, name } = v;
  if (placeId !== undefined && (typeof placeId !== 'string' || !placeId)) throw bad('BAD_REQUEST', 'place.placeId must be a non-empty string.');
  if (lat !== undefined && (typeof lat !== 'number' || !(lat >= -90 && lat <= 90))) throw bad('BAD_REQUEST', 'place.lat must be a latitude.');
  if (lon !== undefined && (typeof lon !== 'number' || !(lon >= -180 && lon <= 180))) throw bad('BAD_REQUEST', 'place.lon must be a longitude.');
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) throw bad('BAD_REQUEST', 'place.name must be non-empty text.');
  return {
    ...(placeId !== undefined ? { placeId } : {}),
    ...(lat !== undefined ? { lat } : {}),
    ...(lon !== undefined ? { lon } : {}),
    ...(typeof name === 'string' ? { name: name.trim() } : {}),
  };
}

/** `did:key:z6MkhaXg…` → `did:key:z6Mkha…Xg12` style: short enough for a title, still recognisable. */
export function abbreviateDid(did: string): string {
  const cut = did.lastIndexOf(':');
  const head = did.slice(0, cut + 1);
  const tail = did.slice(cut + 1);
  return tail.length <= 12 ? did : `${head}${tail.slice(0, 6)}…${tail.slice(-4)}`;
}

/**
 * Creates the ad-hoc meeting Trust Task for `POST /witness`: an `events` row with `kind = 'meeting'`,
 * `id = 'meet-<tid>'`, starting now and ending an hour later, the witness as sole convener, `attestation: true`,
 * and a pod-signed `org.bioregion.event.attestation` task document carrying `kind: 'meeting'`.
 */
async function createMeeting(ctx: VtaContext, deps: Pick<PodVtaDeps, 'podSigner'>, witness: string, place: MeetingPlace): Promise<EventRow> {
  const now = ctx.now();
  const id = `${MEETING_PREFIX}${tid(ctx.now)}`;
  const title = `Meeting witnessed by ${abbreviateDid(witness)}`;
  const startsAt = now.toISOString();
  const endsAt = new Date(now.getTime() + MEETING_DURATION_MS).toISOString();
  const unsigned = {
    type: 'org.bioregion.event.attestation' as const,
    kind: 'meeting' as const,
    createdAt: startsAt,
    seq: 0,
    id,
    pod: ctx.podDid,
    startsAt,
    endsAt,
    conveners: [witness],
    location: {
      ...(place.placeId ? { placeId: place.placeId } : {}),
      ...(place.lat !== undefined ? { lat: place.lat } : {}),
      ...(place.lon !== undefined ? { lon: place.lon } : {}),
      name: place.name ?? title,
    },
  };
  EventAttestationDocumentSchema.parse(unsigned);
  const taskDocument = deps.podSigner.sign(unsigned, { created: startsAt });
  const taskDigest = digestMultibase(taskDocument);
  const [row] = await ctx.db.query<EventRow>(
    `INSERT INTO events (id, title, starts_at, ends_at, place_id, conveners, task_document, task_digest, attestation, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, 'meeting') RETURNING *`,
    [id, title, startsAt, endsAt, place.placeId ?? null, JSON.stringify([witness]), JSON.stringify(taskDocument), taskDigest],
  );
  return row!;
}

/**
 * `POST /witness` — meetings as Trust Tasks (Task 21a). Peer-to-peer attestation works without a scheduled
 * event: anyone whose session carries `vwc:issue` (the route checks it) may witness a relationship they saw in
 * person. The in-person ceremony is unchanged — both signed VRC halves, a witness who is neither party — only the
 * scheduled event is replaced by an ad-hoc meeting Trust Task created here, to which the VWC is bound exactly as
 * at an event (so `checkWitness` admits with it unchanged). The witness need not convene any event.
 *
 * Same rules as `witnessEdge`: both halves verified, parties derived, no self-witness, a pair is witnessed once
 * per pod (the same witness re-posting gets the stored VWC back with `existing: true` and its original task; no
 * new meeting row is created for a recovery).
 */
export async function witnessMeeting(
  ctx: VtaContext,
  deps: Pick<PodVtaDeps, 'podSigner' | 'resolver'>,
  witness: string,
  body: unknown,
): Promise<{ vwc: VerifiableCredential; task: EventView; existing?: true }> {
  const req = await parseWitnessRequest(deps, body);
  const place = parsePlace(isObject(body) ? body['place'] : undefined);
  refuseSelfWitness(req, witness, 'witness');
  const recovered = await existingWitness(ctx, req.pair.digest, witness);
  if (recovered) {
    const taskId = recovered.vwc.credentialSubject?.['taskContext'];
    const taskRow = typeof taskId === 'string' ? await getEventRow(ctx, taskId) : undefined;
    if (!taskRow) throw alreadyWitnessed();
    return { ...recovered, task: eventView(taskRow, true) };
  }
  const row = await createMeeting(ctx, deps, witness, place);
  const out = await issueWitness(ctx, deps, witness, row, req);
  return { ...out, task: eventView(row, true) };
}

export interface WitnessVolume {
  witness: string;
  /** Relationships (VRC pairs) this DID witnessed in the window. */
  pairs: number;
  atEvents: number;
  atMeetings: number;
  /** People admitted with those VWCs (sum of `witness_refs.used_by`). */
  admitted: number;
  firstAt: string | null;
  lastAt: string | null;
}

/**
 * Witness volume per witness DID (FR-TR-3 anomaly input; `GET /steward/witnesses`). Counts relationships
 * witnessed since `sinceDays` days ago (all time when omitted), split by scheduled events and ad-hoc meetings,
 * highest volume first. Smoke rows are excluded. A plain function so the trust index can call it later.
 */
export async function witnessVolume(ctx: VtaContext, sinceDays?: number): Promise<WitnessVolume[]> {
  const since = sinceDays !== undefined && Number.isFinite(sinceDays) && sinceDays >= 0
    ? new Date(ctx.now().getTime() - sinceDays * 86_400_000).toISOString()
    : null;
  const rows = await ctx.db.query<{ witness: string; pairs: unknown; at_meetings: unknown; admitted: unknown; first_at: unknown; last_at: unknown }>(
    `SELECT w.convener_did AS witness,
            COUNT(*) AS pairs,
            COUNT(*) FILTER (WHERE e.kind = 'meeting' OR w.event_id LIKE 'meet-%') AS at_meetings,
            COALESCE(SUM(jsonb_array_length(COALESCE(w.used_by, '[]'::jsonb))), 0) AS admitted,
            MIN(w.created_at) AS first_at,
            MAX(w.created_at) AS last_at
       FROM witness_refs w
       LEFT JOIN events e ON e.id = w.event_id
      WHERE w.convener_did IS NOT NULL
        AND (w.event_id IS NULL OR w.event_id NOT LIKE 'smoke-%')
        AND ($1::timestamptz IS NULL OR w.created_at >= $1::timestamptz)
      GROUP BY w.convener_did
      ORDER BY COUNT(*) DESC, w.convener_did`,
    [since],
  );
  return rows.map((r) => {
    const pairs = Number(r.pairs);
    const atMeetings = Number(r.at_meetings);
    return {
      witness: r.witness,
      pairs,
      atEvents: pairs - atMeetings,
      atMeetings,
      admitted: Number(r.admitted),
      firstAt: toIso(r.first_at),
      lastAt: toIso(r.last_at),
    };
  });
}
