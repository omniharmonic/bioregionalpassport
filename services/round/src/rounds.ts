/**
 * Grants rounds (PRD F6, FR-GR-1..5; B3 §9): lifecycle draft → open → tallying → published, proposals,
 * pseudonymous quadratic ballots, steward adjustments and publication as `org.bioregion.project` records.
 * Every function runs inside the pod transaction handed over as `ctx.db` (already scoped by `withPod`).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalize, randomNonce, verifyDocument, type VerifiablePresentation } from '@passport/credential-core';
import { ProjectRecordSchema, recordUri, type ProjectRecord } from '@passport/lexicons';
import { ServiceError, type SessionClaims } from '@passport/service-kit';
import { verifyDTG } from '@passport/verifier-sdk';
import { TIERS, tierRank, type Tier } from '@passport/vocab';
import {
  DEFAULT_VOICE_BUDGET,
  ROUND_WEIGHTS,
  signedPart,
  tally,
  voiceCost,
  type PublishedBallot,
  type SignedBallot,
  type Tally,
  type TallyAdjustment,
} from './tally.js';
import { ROUND_STATUSES, type Eligibility, type RoundContext, type RoundDeps, type RoundStatus } from './types.js';
import { bad, day, isObject, json, num, toIso } from './util.js';

/** A group casting through a delegation chain votes at this tier (weight 1.0). */
export const GROUP_TIER: Tier = 'T2';

export interface RoundView {
  id: string;
  title: string;
  pool: number;
  unit: string | null;
  opensAt: string | null;
  closesAt: string | null;
  eligibility: Eligibility;
  status: RoundStatus;
  publishedAt: string | null;
}

export interface ProposalView {
  id: string;
  roundId: string;
  title: string;
  summary: string | null;
  budget: number;
  leadDid: string | null;
  placeId: string | null;
  record: ProjectRecord;
  createdAt: string | null;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────

const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v);
const tierOk = (have: string | undefined, min: string): boolean => isTier(have) && isTier(min) && tierRank(have) >= tierRank(min);

function requireText(v: unknown, field: string, max = 500): string {
  if (typeof v !== 'string' || !v.trim()) throw bad('BAD_REQUEST', `A round needs a ${field}.`);
  if (v.length > max) throw bad('BAD_REQUEST', `The ${field} is too long (at most ${max} characters).`);
  return v.trim();
}

function requireDate(v: unknown, field: string): string {
  const iso = typeof v === 'string' ? toIso(v) : null;
  if (!iso) throw bad('BAD_REQUEST', `${field} must be a date and time.`);
  return iso;
}

function eligibilityOf(raw: unknown): Eligibility {
  const e = isObject(json(raw)) ? json<Record<string, any>>(raw) : {};
  const out: Eligibility = {
    proposeTier: isTier(e['proposeTier']) ? e['proposeTier'] : 'T2',
    voteTier: isTier(e['voteTier']) ? e['voteTier'] : 'T2',
    voiceBudget: typeof e['voiceBudget'] === 'number' ? e['voiceBudget'] : DEFAULT_VOICE_BUDGET,
  };
  if (typeof e['matchingCap'] === 'number') out.matchingCap = e['matchingCap'];
  return out;
}

function parseEligibility(v: unknown): Eligibility {
  if (v === undefined || v === null) return eligibilityOf({});
  if (!isObject(v)) throw bad('BAD_REQUEST', 'Eligibility must be an object.');
  for (const k of ['proposeTier', 'voteTier'] as const) {
    if (v[k] !== undefined && (!isTier(v[k]) || v[k] === 'T0')) throw bad('BAD_REQUEST', `${k} must be one of T1, T2, T3 or T4.`);
  }
  if (v['voiceBudget'] !== undefined && (!Number.isInteger(v['voiceBudget']) || v['voiceBudget'] < 1 || v['voiceBudget'] > 1_000_000)) {
    throw bad('BAD_REQUEST', 'The voice budget must be a whole number of voice credits of at least 1.');
  }
  if (v['matchingCap'] !== undefined && (typeof v['matchingCap'] !== 'number' || !Number.isFinite(v['matchingCap']) || v['matchingCap'] <= 0)) {
    throw bad('BAD_REQUEST', 'The matching cap must be a positive amount.');
  }
  return eligibilityOf(v);
}

function roundView(r: any): RoundView {
  return {
    id: r.id,
    title: r.title,
    pool: num(r.pool),
    unit: r.unit ?? null,
    opensAt: toIso(r.opens_at),
    closesAt: toIso(r.closes_at),
    eligibility: eligibilityOf(r.eligibility),
    status: r.status,
    publishedAt: toIso(r.published_at),
  };
}

function proposalView(p: any): ProposalView {
  return {
    id: p.id,
    roundId: p.round_id,
    title: p.title,
    summary: p.summary ?? null,
    budget: num(p.budget),
    leadDid: p.lead_did ?? null,
    placeId: p.place_id ?? null,
    record: json(p.record),
    createdAt: toIso(p.created_at),
  };
}

async function loadRound(ctx: RoundContext, id: string, forUpdate = false): Promise<{ view: RoundView; tally: Tally | null }> {
  const rows = await ctx.db.query(`SELECT * FROM rounds WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  const r = rows[0];
  if (!r) throw new ServiceError(404, 'ROUND_NOT_FOUND', 'There is no grants round with that id in this pod.');
  return { view: roundView(r), tally: r.tally ? json<Tally>(r.tally) : null };
}

function requireStatus(round: RoundView, allowed: RoundStatus[], message: string): void {
  if (!allowed.includes(round.status)) throw new ServiceError(409, 'WRONG_ROUND_STATUS', message);
}

/** The session must be a membership session for this pod. */
export function requirePodSession(ctx: RoundContext, session: SessionClaims): void {
  if (session.pod !== ctx.podDid) {
    throw new ServiceError(403, 'POD_MISMATCH', 'Your session is not a membership session for this pod.');
  }
}

/** Public view of a tally: the adjustment log (steward DIDs and reasons) is shown only once published. */
export function publicTally(t: Tally, status: RoundStatus, steward: boolean): Tally | Omit<Tally, 'adjustments'> {
  if (status === 'published' || steward) return t;
  const { adjustments: _hidden, ...rest } = t;
  return rest;
}

const sha256Hex = (s: string): string => bytesToHex(sha256(utf8ToBytes(s)));

/** `sha256(round_id ‖ principal)`, hex. Binds one ballot per member (or group) per round; never published. */
export const voterHash = (roundId: string, principal: string): string => sha256Hex(roundId + principal);

// ── rounds ───────────────────────────────────────────────────────────────────────────────────────────

export interface RoundInput {
  title: unknown;
  pool: unknown;
  unit?: unknown;
  opensAt: unknown;
  closesAt: unknown;
  eligibility?: unknown;
}

export async function createRound(ctx: RoundContext, input: RoundInput): Promise<RoundView> {
  if (!isObject(input)) throw bad('BAD_REQUEST', 'A round needs a title, a pool, and opening and closing dates.');
  const title = requireText(input.title, 'title', 200);
  const pool = input.pool;
  if (typeof pool !== 'number' || !Number.isFinite(pool) || pool < 0 || pool > 1e12) {
    throw bad('BAD_REQUEST', 'The pool must be an amount of zero or more.');
  }
  const unit = input.unit === undefined ? ctx.manifest.currency.unit : requireText(input.unit, 'unit', 40);
  const opensAt = requireDate(input.opensAt, 'opensAt');
  const closesAt = requireDate(input.closesAt, 'closesAt');
  if (Date.parse(closesAt) <= Date.parse(opensAt)) throw bad('BAD_REQUEST', 'A round must close after it opens.');
  const eligibility = parseEligibility(input.eligibility);
  const id = `rnd_${randomNonce(12)}`;
  const rows = await ctx.db.query(
    `INSERT INTO rounds (id, title, pool, unit, opens_at, closes_at, eligibility, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'draft') RETURNING *`,
    [id, title, Math.round(pool * 100) / 100, unit, opensAt, closesAt, JSON.stringify(eligibility)],
  );
  return roundView(rows[0]);
}

export async function openRound(ctx: RoundContext, id: string): Promise<RoundView> {
  const { view } = await loadRound(ctx, id, true);
  requireStatus(view, ['draft'], 'Only a draft round can be opened.');
  const rows = await ctx.db.query(`UPDATE rounds SET status = 'open' WHERE id = $1 RETURNING *`, [id]);
  return roundView(rows[0]);
}

export async function listRounds(ctx: RoundContext, status?: string): Promise<RoundView[]> {
  if (status !== undefined && !(ROUND_STATUSES as readonly string[]).includes(status)) {
    throw bad('BAD_REQUEST', `status must be one of ${ROUND_STATUSES.join(', ')}.`);
  }
  const rows = status
    ? await ctx.db.query(`SELECT * FROM rounds WHERE status = $1 ORDER BY opens_at DESC NULLS LAST, id`, [status])
    : await ctx.db.query(`SELECT * FROM rounds ORDER BY opens_at DESC NULLS LAST, id`);
  return rows.map(roundView);
}

const tallyVisible = (s: RoundStatus): boolean => s === 'tallying' || s === 'published';

export async function getRound(ctx: RoundContext, id: string): Promise<RoundView & { proposals: ProposalView[]; tally?: Tally }> {
  const { view, tally: t } = await loadRound(ctx, id);
  const proposals = await listProposals(ctx, id);
  return { ...view, proposals, ...(tallyVisible(view.status) && t ? { tally: t } : {}) };
}

// ── proposals ────────────────────────────────────────────────────────────────────────────────────────

export interface ProposalInput {
  title: unknown;
  summary?: unknown;
  budget: unknown;
  placeId?: unknown;
  lead?: unknown;
}

export async function createProposal(ctx: RoundContext, session: SessionClaims, roundId: string, input: ProposalInput): Promise<ProposalView> {
  const { view } = await loadRound(ctx, roundId, true);
  const steward = session.authorities.includes('pep:review');
  if (!(view.status === 'open' || (view.status === 'draft' && steward))) {
    throw new ServiceError(409, 'WRONG_ROUND_STATUS', view.status === 'draft' ? 'This round is not open for proposals yet.' : 'This round no longer takes proposals.');
  }
  if (!tierOk(session.tier, view.eligibility.proposeTier)) {
    throw new ServiceError(403, 'TIER_TOO_LOW', `Proposing in this round needs tier ${view.eligibility.proposeTier} or above.`);
  }
  if (!isObject(input)) throw bad('BAD_REQUEST', 'A proposal needs a title and a budget.');
  const title = requireText(input.title, 'title', 200);
  const summary = input.summary === undefined || input.summary === null ? undefined : requireText(input.summary, 'summary', 5000);
  const budget = input.budget;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0 || budget > 1e12) {
    throw bad('BAD_REQUEST', 'The budget must be a positive amount.');
  }
  const placeId = input.placeId === undefined || input.placeId === null ? undefined : requireText(input.placeId, 'placeId', 200);
  // The published lead is always the proposing member (`lead_did`); `body.lead` is ignored.
  const lead = session.subject;
  const record = ProjectRecordSchema.parse({
    bioregion: ctx.slug,
    title,
    ...(summary !== undefined ? { summary } : {}),
    round: roundId,
    budget: Math.round(budget * 100) / 100,
    lead,
    ...(placeId !== undefined ? { placeId } : {}),
    funded: false,
  });
  const id = `prp_${randomNonce(12)}`;
  const rows = await ctx.db.query(
    `INSERT INTO proposals (id, round_id, title, summary, budget, lead_did, place_id, record, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) RETURNING *`,
    [id, roundId, title, summary ?? null, record.budget, session.subject, placeId ?? null, JSON.stringify(record), ctx.now().toISOString()],
  );
  return proposalView(rows[0]);
}

export async function listProposals(ctx: RoundContext, roundId: string): Promise<ProposalView[]> {
  const rows = await ctx.db.query(`SELECT * FROM proposals WHERE round_id = $1 ORDER BY created_at, id`, [roundId]);
  return rows.map(proposalView);
}

// ── ballots ──────────────────────────────────────────────────────────────────────────────────────────

const BALLOT_KEYS = new Set(['round', 'voterKey', 'issuer', 'allocations', 'createdAt', 'nonce', 'proof']);

function parseSignedBallot(body: Record<string, any>, roundId: string): SignedBallot {
  let b: unknown = body['ballot'];
  // The signed ballot is `ballot` itself (carrying `proof`) or, equivalently, `signature`.
  if (isObject(b) && b['proof'] === undefined && isObject(body['signature'])) b = body['signature'];
  if (!isObject(b)) throw bad('BAD_BALLOT', 'A vote needs a signed ballot.');
  if (!isObject(b['proof'])) throw bad('BAD_BALLOT', 'This ballot is not signed with your round key.');
  for (const k of Object.keys(b)) {
    if (!BALLOT_KEYS.has(k)) throw bad('BAD_BALLOT', `A ballot may not carry the field "${k}".`);
  }
  if (b['round'] !== roundId) throw bad('WRONG_ROUND', 'This ballot was made for a different round.');
  const voterKey = b['voterKey'];
  if (typeof voterKey !== 'string' || !voterKey.startsWith('did:key:')) throw bad('BAD_BALLOT', 'A ballot must name its per-round voting key (a did:key).');
  if (b['issuer'] !== voterKey) throw bad('BAD_BALLOT', 'A ballot must be issued by its voting key.');
  if (typeof b['createdAt'] !== 'string' || !toIso(b['createdAt'])) throw bad('BAD_BALLOT', 'A ballot needs a creation time.');
  if (typeof b['nonce'] !== 'string' || b['nonce'].length < 8 || b['nonce'].length > 200) throw bad('BAD_BALLOT', 'A ballot needs a nonce.');
  const allocations = b['allocations'];
  if (!isObject(allocations)) throw bad('BAD_BALLOT', 'A ballot needs allocations.');
  for (const [pid, v] of Object.entries(allocations)) {
    if (!Number.isInteger(v) || (v as number) < 0) throw bad('BAD_BALLOT', `Votes for ${pid} must be a whole number of zero or more.`);
  }
  return b as unknown as SignedBallot;
}

export interface BallotResult {
  ballotId: string;
  voterKey: string;
  cost: number;
  voiceBudget: number;
  replaced: boolean;
  onBehalfOf?: string;
  message: string;
}

/**
 * Records a ballot. Rules: round `open` and now within [opensAt, closesAt]; every allocation names a proposal
 * of this round; Σ votes² ≤ voice budget; the proof verifies against `voterKey` (assertionMethod). The ballot
 * is bound to the voter only through `ballot_voters.voter_hash`; a later ballot from the same voter replaces
 * the earlier one (last ballot wins until close).
 *
 * Group votes: `linkage.presentation` is verified with `verifyDTG` (delegation allowed, `round:vote`
 * required, challenge = round id, domain = pod domain); its holder must be the session subject, and the vote
 * is cast for `delegatedFor` (one ballot per group, weight of T2).
 */
export async function submitBallot(
  ctx: RoundContext,
  deps: RoundDeps,
  session: SessionClaims,
  roundId: string,
  body: unknown,
): Promise<BallotResult> {
  requirePodSession(ctx, session);
  const linkage = isObject(body) && isObject(body['linkage']) ? body['linkage'] : undefined;
  const groupPath = linkage?.['presentation'] !== undefined;
  if (!groupPath) {
    // Personal path: the session itself must carry round:vote and must not be a delegated (group) session.
    if (!session.authorities.includes('round:vote')) {
      throw new ServiceError(403, 'MISSING_AUTHORITY', 'This needs the "round:vote" authority, which your passport does not carry.');
    }
    if (session.delegatedFor) {
      throw bad('DELEGATED_SESSION', 'This session acts for a group, so vote for the group by sending its delegation presentation with the ballot.');
    }
  }
  const { view } = await loadRound(ctx, roundId, true);
  if (view.status !== 'open') throw new ServiceError(409, 'ROUND_NOT_OPEN', 'This round is not open for voting.');
  const now = ctx.now().getTime();
  if (view.opensAt && now < Date.parse(view.opensAt)) {
    throw new ServiceError(409, 'ROUND_NOT_OPEN', `Voting in this round opens on ${day(view.opensAt)}.`);
  }
  if (view.closesAt && now > Date.parse(view.closesAt)) {
    throw new ServiceError(409, 'ROUND_NOT_OPEN', `Voting in this round closed on ${day(view.closesAt)}.`);
  }
  if (!isObject(body)) throw bad('BAD_BALLOT', 'A vote needs a signed ballot.');
  const ballot = parseSignedBallot(body, roundId);

  const proposalIds = new Set((await ctx.db.query<{ id: string }>(`SELECT id FROM proposals WHERE round_id = $1`, [roundId])).map((r) => r.id));
  for (const pid of Object.keys(ballot.allocations)) {
    if (!proposalIds.has(pid)) throw bad('UNKNOWN_PROPOSAL', `This ballot votes for ${pid}, which is not a proposal in this round.`);
  }
  const cost = voiceCost(ballot.allocations);
  const budget = view.eligibility.voiceBudget;
  if (cost > budget) throw bad('OVER_BUDGET', `This ballot spends ${cost} voice credits but you have ${budget}.`);

  const proofCheck = await verifyDocument(ballot, deps.resolver, { proofPurpose: 'assertionMethod' });
  if (!proofCheck.ok || proofCheck.controller !== ballot.voterKey) {
    throw bad('BAD_PROOF', `The ballot's signature did not check out against its voting key (${proofCheck.error ?? 'wrong signer'}).`);
  }

  // Who is voting: a group (through a verified delegation) or the member behind the session.
  let principal: string;
  let tier: string | undefined;
  let onBehalfOf: string | undefined;
  if (groupPath) {
    if (!isObject(linkage!['presentation'])) throw bad('BAD_REQUEST', 'The group presentation could not be read.');
    const result = await verifyDTG(
      linkage!['presentation'] as unknown as VerifiablePresentation,
      {
        acceptedPods: [ctx.podDid],
        requireAuthority: ['round:vote'],
        allowDelegation: true,
        challenge: roundId,
        domain: `${ctx.slug}.${ctx.platformDomain}`,
        podNames: { [ctx.podDid]: ctx.manifest.identity.name },
      },
      {
        resolver: deps.resolver,
        now: ctx.now,
        ...(deps.statusFetch ? { statusFetch: (url: string) => deps.statusFetch!(url, ctx) } : {}),
      },
    );
    if (!result.ok) {
      const code = result.error?.code ?? 'BAD_PROOF';
      throw new ServiceError(403, code, result.error?.message ?? 'The group presentation was refused.');
    }
    if (result.subject !== session.subject) {
      throw new ServiceError(403, 'HOLDER_MISMATCH', 'The group presentation was made by someone other than you.');
    }
    if (!result.delegatedFor) {
      throw bad('NOT_A_GROUP_VOTE', 'This presentation does not show a group delegation for round:vote, so send your own ballot without it.');
    }
    principal = onBehalfOf = result.delegatedFor;
    tier = GROUP_TIER;
    if (!tierOk(tier, view.eligibility.voteTier)) {
      throw new ServiceError(403, 'TIER_TOO_LOW', `Voting in this round needs tier ${view.eligibility.voteTier} or above, and groups vote at ${GROUP_TIER}.`);
    }
  } else {
    principal = session.subject;
    tier = session.tier;
    if (!tierOk(tier, view.eligibility.voteTier)) {
      throw new ServiceError(403, 'TIER_TOO_LOW', `Voting in this round needs tier ${view.eligibility.voteTier} or above.`);
    }
  }
  const hash = voterHash(roundId, principal);

  const keyOwner = await ctx.db.query<{ voter_hash: string }>(
    `SELECT v.voter_hash FROM ballots b JOIN ballot_voters v ON v.ballot_id = b.id WHERE b.round_id = $1 AND b.voter_key = $2`,
    [roundId, ballot.voterKey],
  );
  if (keyOwner.some((r) => r.voter_hash !== hash)) {
    throw new ServiceError(409, 'VOTER_KEY_IN_USE', 'This voting key already cast a ballot for someone else in this round.');
  }
  const previous = await ctx.db.query<{ ballot_id: string }>(`SELECT ballot_id FROM ballot_voters WHERE round_id = $1 AND voter_hash = $2`, [roundId, hash]);
  const replaced = previous.length > 0;
  if (replaced) {
    await ctx.db.query(`DELETE FROM ballots WHERE id = $1`, [previous[0]!.ballot_id]);
    await ctx.db.query(`DELETE FROM ballot_voters WHERE round_id = $1 AND voter_hash = $2`, [roundId, hash]);
  }
  const published: PublishedBallot = { ...ballot, tier: tier ?? GROUP_TIER, ...(onBehalfOf ? { onBehalfOf } : {}) };
  const id = `blt_${randomNonce(12)}`;
  const at = ctx.now().toISOString();
  await ctx.db.query(
    `INSERT INTO ballots (id, round_id, voter_key, ballot, signature, created_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [id, roundId, ballot.voterKey, JSON.stringify(published), ballot.proof.proofValue, at],
  );
  await ctx.db.query(`INSERT INTO ballot_voters (round_id, voter_hash, ballot_id, created_at) VALUES ($1, $2, $3, $4)`, [roundId, hash, id, at]);
  return {
    ballotId: id,
    voterKey: ballot.voterKey,
    cost,
    voiceBudget: budget,
    replaced,
    ...(onBehalfOf ? { onBehalfOf } : {}),
    message: replaced
      ? 'Your new ballot replaced your earlier one; the last ballot you send before the round closes is the one counted.'
      : 'Your ballot is recorded; you can change it until the round closes, and the last one you send is counted.',
  };
}

/** Published ballots of a round (never voter hashes or session subjects), in canonical order. */
export async function publishedBallots(ctx: RoundContext, roundId: string): Promise<PublishedBallot[]> {
  const rows = await ctx.db.query(`SELECT ballot FROM ballots WHERE round_id = $1 ORDER BY voter_key`, [roundId]);
  return rows.map((r) => {
    const b = json<PublishedBallot>(r.ballot);
    return {
      round: b.round,
      voterKey: b.voterKey,
      issuer: b.issuer,
      allocations: b.allocations,
      createdAt: b.createdAt,
      nonce: b.nonce,
      proof: b.proof,
      tier: b.tier,
      ...(b.onBehalfOf ? { onBehalfOf: b.onBehalfOf } : {}),
    };
  });
}

// ── close, adjust, publish ───────────────────────────────────────────────────────────────────────────

async function adjustmentsOf(ctx: RoundContext, roundId: string): Promise<TallyAdjustment[]> {
  const rows = await ctx.db.query(`SELECT * FROM adjustments WHERE round_id = $1 ORDER BY id`, [roundId]);
  return rows.map((r) => ({
    proposalId: r.proposal_id,
    delta: num(r.delta),
    reason: r.reason,
    stewardDid: r.steward_did,
    createdAt: toIso(r.created_at)!,
  }));
}

async function computeTally(ctx: RoundContext, round: RoundView, adjustments: TallyAdjustment[], computedAt: string): Promise<Tally> {
  const ballots = await publishedBallots(ctx, round.id);
  const proposals = await listProposals(ctx, round.id);
  return tally(ballots, proposals, ROUND_WEIGHTS, round.pool, {
    matchingCap: round.eligibility.matchingCap ?? null,
    adjustments,
    computedAt,
  });
}

async function storeTally(ctx: RoundContext, id: string, t: Tally, status?: RoundStatus): Promise<void> {
  if (status) await ctx.db.query(`UPDATE rounds SET tally = $2::jsonb, status = $3 WHERE id = $1`, [id, JSON.stringify(t), status]);
  else await ctx.db.query(`UPDATE rounds SET tally = $2::jsonb WHERE id = $1`, [id, JSON.stringify(t)]);
}

/** Closes voting and computes the tally; the round moves to `tallying` for steward review. */
export async function closeRound(ctx: RoundContext, id: string): Promise<{ round: RoundView; tally: Tally }> {
  const { view } = await loadRound(ctx, id, true);
  requireStatus(view, ['open'], 'Only an open round can be closed.');
  const t = await computeTally(ctx, view, [], ctx.now().toISOString());
  await storeTally(ctx, id, t, 'tallying');
  return { round: { ...view, status: 'tallying' }, tally: t };
}

/** Logs a steward adjustment (sybil findings etc.) and re-tallies; the tally lists every adjustment. */
export async function addAdjustment(
  ctx: RoundContext,
  session: SessionClaims,
  id: string,
  input: unknown,
): Promise<{ adjustment: TallyAdjustment; tally: Tally }> {
  const { view } = await loadRound(ctx, id, true);
  requireStatus(view, ['tallying'], 'Adjustments can only be made while the round is being tallied.');
  if (!isObject(input)) throw bad('BAD_REQUEST', 'An adjustment needs a proposal, an amount and a reason.');
  const { proposalId, delta, reason } = input;
  if (typeof proposalId !== 'string') throw bad('BAD_REQUEST', 'An adjustment needs a proposal.');
  const known = await ctx.db.query(`SELECT id FROM proposals WHERE id = $1 AND round_id = $2`, [proposalId, id]);
  if (!known.length) throw bad('UNKNOWN_PROPOSAL', `${proposalId} is not a proposal in this round.`);
  if (typeof delta !== 'number' || !Number.isFinite(delta) || Math.round(delta * 100) === 0 || Math.abs(delta) > 1e12) {
    throw bad('BAD_REQUEST', 'An adjustment must change matching by a non-zero amount.');
  }
  if (typeof reason !== 'string' || reason.trim().length < 3) throw bad('REASON_REQUIRED', 'Every adjustment needs a reason that will be published with the tally.');
  const adjustment: TallyAdjustment = {
    proposalId,
    delta: Math.round(delta * 100) / 100,
    reason: reason.trim().slice(0, 2000),
    stewardDid: session.subject,
    createdAt: ctx.now().toISOString(),
  };
  const all = [...(await adjustmentsOf(ctx, id)), adjustment];
  const t = await computeTally(ctx, view, all, ctx.now().toISOString());
  const entry = t.proposals.find((p) => p.id === proposalId)!;
  if (entry.matching < 0) throw bad('NEGATIVE_MATCHING', `This adjustment would take ${proposalId} below zero matching.`);
  if (Math.round(t.totalMatching * 100) > Math.round(t.pool * 100)) {
    throw bad('OVER_POOL', "Adjustments cannot allocate more than the round's pool.");
  }
  await ctx.db.query(
    `INSERT INTO adjustments (round_id, proposal_id, steward_did, delta, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, proposalId, adjustment.stewardDid, adjustment.delta, adjustment.reason, adjustment.createdAt],
  );
  await storeTally(ctx, id, t);
  return { adjustment, tally: t };
}

export async function listAdjustments(ctx: RoundContext, id: string): Promise<TallyAdjustment[]> {
  await loadRound(ctx, id);
  return adjustmentsOf(ctx, id);
}

/** Publishes the result: status `published` and one open `org.bioregion.project` record per proposal. */
export async function publishRound(ctx: RoundContext, id: string): Promise<{ round: RoundView; records: { uri: string; record: ProjectRecord }[] }> {
  const { view, tally: t } = await loadRound(ctx, id, true);
  requireStatus(view, ['tallying'], 'Only a round that has been closed and tallied can be published.');
  if (!t) throw new ServiceError(409, 'NO_TALLY', 'This round has no tally to publish.');
  const at = ctx.now().toISOString();
  const records: { uri: string; record: ProjectRecord }[] = [];
  for (const p of await listProposals(ctx, id)) {
    const entry = t.proposals.find((e) => e.id === p.id);
    if (!entry) throw new ServiceError(409, 'STALE_TALLY', 'The tally does not cover every proposal; close the round again.');
    const record = ProjectRecordSchema.parse({ ...p.record, bioregion: ctx.slug, funded: entry.matching > 0, tally: entry });
    const uri = recordUri(ctx.slug, 'project', p.id);
    await ctx.db.query(
      `INSERT INTO records (uri, collection, bioregion, place_id, author_did, record, created_at, updated_at)
       VALUES ($1, 'project', $2, $3, $4, $5::jsonb, $6, $6)
       ON CONFLICT (uri) DO UPDATE SET place_id = excluded.place_id, author_did = excluded.author_did, record = excluded.record, updated_at = excluded.updated_at`,
      [uri, ctx.slug, p.placeId, ctx.podDid, JSON.stringify(record), at],
    );
    await ctx.db.query(`UPDATE proposals SET record = $2::jsonb WHERE id = $1`, [p.id, JSON.stringify(record)]);
    records.push({ uri, record });
  }
  const rows = await ctx.db.query(`UPDATE rounds SET status = 'published', published_at = $2 WHERE id = $1 RETURNING *`, [id, at]);
  return { round: roundView(rows[0]), records };
}

// ── public tally and verification ────────────────────────────────────────────────────────────────────

export async function getTally(ctx: RoundContext, id: string): Promise<{ round: RoundView; tally: Tally; ballots: PublishedBallot[] }> {
  const { view, tally: t } = await loadRound(ctx, id);
  if (!tallyVisible(view.status) || !t) {
    throw new ServiceError(409, 'TALLY_NOT_READY', 'The tally is published when the round closes.');
  }
  return { round: view, tally: t, ballots: await publishedBallots(ctx, id) };
}

export interface VerifyTallyResult {
  ok: boolean;
  recomputed: Tally;
  stored: Tally;
  problems: string[];
}

/**
 * Re-checks a published ballot set against a stored tally: every signature (against its voting key), every
 * budget, and the tally recomputed from scratch. Pure apart from DID resolution, so it runs anywhere.
 */
export async function verifyTally(
  ballots: PublishedBallot[],
  proposals: readonly (string | { id: string })[],
  stored: Tally,
  deps: RoundDeps,
  opts: { voiceBudget: number; roundId: string },
): Promise<VerifyTallyResult> {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const b of ballots) {
    if (keys.has(b.voterKey)) problems.push(`Voting key ${b.voterKey} appears on more than one ballot.`);
    keys.add(b.voterKey);
    if (b.round !== opts.roundId) problems.push(`Ballot ${b.voterKey} was made for another round.`);
    const signed = signedPart(b);
    const r = await verifyDocument(signed, deps.resolver, { proofPurpose: 'assertionMethod' });
    if (!r.ok || r.controller !== b.voterKey) problems.push(`Ballot ${b.voterKey} has a signature that does not check out.`);
    const cost = voiceCost(b.allocations);
    if (cost > opts.voiceBudget) problems.push(`Ballot ${b.voterKey} spends ${cost} voice credits, over the budget of ${opts.voiceBudget}.`);
  }
  let recomputed: Tally;
  try {
    recomputed = tally(ballots, proposals, ROUND_WEIGHTS, stored.pool, {
      matchingCap: stored.matchingCap,
      adjustments: stored.adjustments,
      computedAt: stored.computedAt,
    });
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
    return { ok: false, recomputed: stored, stored, problems };
  }
  if (canonicalize(recomputed) !== canonicalize(stored)) problems.push('The recomputed tally differs from the stored tally.');
  return { ok: problems.length === 0, recomputed, stored, problems };
}

export async function verifyRound(ctx: RoundContext, deps: RoundDeps, id: string): Promise<VerifyTallyResult> {
  const { round, tally: stored, ballots } = await getTally(ctx, id);
  const proposals = await listProposals(ctx, id);
  const adjustments = await adjustmentsOf(ctx, id);
  const result = await verifyTally(ballots, proposals, stored, deps, { voiceBudget: round.eligibility.voiceBudget, roundId: id });
  // The stored tally must use the round's own pool and cap.
  if (Math.round(stored.pool * 100) !== Math.round(round.pool * 100)) {
    result.problems.push("The tally's pool differs from the round's pool.");
    result.ok = false;
  }
  if ((stored.matchingCap ?? null) !== (round.eligibility.matchingCap ?? null)) {
    result.problems.push("The tally's matching cap differs from the round's matching cap.");
    result.ok = false;
  }
  // The stored tally must also list exactly the logged adjustments (never silently).
  if (canonicalize(adjustments) !== canonicalize(stored.adjustments)) {
    result.problems.push('The adjustments in the tally differ from the steward review log.');
    result.ok = false;
  }
  return result;
}
