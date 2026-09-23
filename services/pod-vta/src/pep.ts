import { buildAuthority, digestMultibase, type VerifiableCredential } from '@passport/credential-core';
import { MAX_VALIDITY_DAYS } from '@passport/credential-core';
import { base64urlnopad } from '@scure/base';
import { ServiceError } from '@passport/service-kit';
import { tierDefaultActions, tierRank, TIERS, type AuthorityScope, type Tier } from '@passport/vocab';
import type { PodVtaDeps, VtaContext } from './types.js';
import { DAY_MS, json, toIso, toMs, validityWindow } from './util.js';

/** Published path of the VAC revocation list (relative to the pod's VTA mount). */
export const VAC_STATUS_LIST = 'vac';
/** Minimum bitstring length (W3C Bitstring Status List: 16 KB, 131 072 entries) for herd privacy. */
export const MIN_STATUS_BITS = 131_072;
/** Re-issue a VAC when it expires within this many days. */
export const REFRESH_WINDOW_DAYS = 7;

export const statusListUrl = (ctx: VtaContext, list = VAC_STATUS_LIST): string =>
  `https://${ctx.slug}.${ctx.platformDomain}/api/vta/status/${list}`;

export interface IssuedAuthorities {
  vacs: VerifiableCredential[];
  explanation: string[];
}

export interface VacLogRow {
  id: string | number;
  subject_did: string;
  actions: unknown;
  tier: string | null;
  policy_version: number | null;
  explanation: unknown;
  credential: unknown;
  issued_at: unknown;
  valid_until: unknown;
  revoked_at: unknown;
}

const isTier = (t: unknown): t is Tier => typeof t === 'string' && (TIERS as readonly string[]).includes(t);

/**
 * The actions a VAC at `tier` carries under this pod's policy: `tierDefaultActions(tier)` plus one policy hook.
 *
 * Policy hook (Task 21a; the trust policy schema task will formalise `admission.witnessTier`): when the pod's
 * policy sets `admission.witnessTier` to 'T2' or lower, Trusted (T2) members also receive `vwc:issue`, so they can
 * witness peers (`POST /witness`) and those witnesses admit. `@passport/vocab` keeps `vwc:issue` at T3 by
 * default, and `event:convene` stays at T3 regardless. T0/T1 never gain `vwc:issue` from this hook.
 */
export function tierActions(ctx: Pick<VtaContext, 'policy'>, tier: Tier): AuthorityScope[] {
  const actions = [...tierDefaultActions(tier)];
  const witnessTier = (ctx.policy as any)?.admission?.witnessTier;
  if (tier === 'T2' && isTier(witnessTier) && tierRank(witnessTier) <= tierRank('T2') && !actions.includes('vwc:issue')) {
    actions.push('vwc:issue');
  }
  return actions;
}

/**
 * PEP issuance. Issues ONE root AuthorityCredential (VAC) scoped to the pod and carrying every default action
 * of `tier` (`tierActions`: the tier defaults plus the policy hook above), rather than one VAC per action: fewer credentials to hold and present, and
 * the verifier SDK accepts multi-action VACs (it matches the required action within `authority.actions`).
 *
 * The audit row is written first so its identity `id` can be the VAC's status-list index
 * (`credentialStatus.statusListIndex`), then the signed credential is stored on that row.
 * T0 has no default actions, so nothing is issued for it.
 */
export async function issueAuthorities(
  ctx: VtaContext,
  deps: Pick<PodVtaDeps, 'podSigner'>,
  did: string,
  tier: Tier,
  explanation: string[],
): Promise<IssuedAuthorities> {
  const actions = tierActions(ctx, tier);
  if (!actions.length) return { vacs: [], explanation: [...explanation, `Tier ${tier} carries no authorities, so none were issued.`] };
  const now = ctx.now();
  const { validFrom, validUntil } = validityWindow(now, ctx.policy.vacValidityDays, MAX_VALIDITY_DAYS.authority);
  const policyVersion = ctx.policy.version;
  const lines = [...explanation, `Issued tier ${tier} authorities (${actions.length} actions) valid until ${validUntil.slice(0, 10)}.`];

  const [row] = await ctx.db.query<{ id: string | number }>(
    `INSERT INTO vac_issuance_log (subject_did, actions, tier, policy_version, explanation, issued_at, valid_until)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [did, JSON.stringify(actions), tier, policyVersion, JSON.stringify(lines), validFrom, validUntil],
  );
  const id = String(row!.id);
  const unsigned = buildAuthority({
    issuer: ctx.podDid,
    subject: did,
    scope: ctx.podDid,
    actions,
    validFrom,
    validUntil,
    tier,
    policyVersion,
  });
  unsigned.credentialStatus = {
    id: `${statusListUrl(ctx)}#${id}`,
    type: 'BitstringStatusListEntry',
    statusPurpose: 'revocation',
    statusListIndex: id,
    statusListCredential: statusListUrl(ctx),
  };
  let vac: VerifiableCredential;
  try {
    vac = deps.podSigner.sign(unsigned, { created: validFrom });
    await ctx.db.query('UPDATE vac_issuance_log SET credential = $2 WHERE id = $1', [id, JSON.stringify(vac)]);
  } catch (e) {
    // Never leave an unsigned audit row behind (nested transactions reuse the outer one, so delete explicitly).
    await ctx.db.query('DELETE FROM vac_issuance_log WHERE id = $1 AND credential IS NULL', [id]);
    throw e;
  }
  return { vacs: [vac], explanation: lines };
}

/** PEP-only write: the effective tier and until when the VAC carrying it is valid (migration 0006). */
export async function setEffective(ctx: VtaContext, did: string, tier: Tier, until: string | null): Promise<void> {
  await ctx.db.query('UPDATE members SET effective_tier = $2, effective_until = $3 WHERE did = $1', [did, tier, until]);
}

/** Latest unrevoked VAC log row for `did`, or undefined. */
export async function latestVac(ctx: VtaContext, did: string): Promise<VacLogRow | undefined> {
  const rows = await ctx.db.query<VacLogRow>(
    `SELECT * FROM vac_issuance_log WHERE subject_did = $1 AND revoked_at IS NULL AND credential IS NOT NULL
      ORDER BY issued_at DESC, id DESC LIMIT 1`,
    [did],
  );
  return rows[0];
}

export interface RefreshResult {
  tier: Tier;
  issued: boolean;
  /** Every currently valid, unrevoked VAC the member holds after the refresh (newest first). */
  vacs: VerifiableCredential[];
  explanation: string[];
  next?: { tier: Tier; missing: string[]; hints: string[] };
}

/** Unrevoked VAC rows of `did` that are valid at `now`, newest first. */
export async function validVacs(ctx: VtaContext, did: string): Promise<VacLogRow[]> {
  return ctx.db.query<VacLogRow>(
    `SELECT * FROM vac_issuance_log
      WHERE subject_did = $1 AND revoked_at IS NULL AND credential IS NOT NULL AND valid_until > $2
      ORDER BY issued_at DESC, id DESC`,
    [did, ctx.now().toISOString()],
  );
}

const maxTier = (a: Tier, b: Tier): Tier => (tierRank(a) >= tierRank(b) ? a : b);

/**
 * `POST /authority/refresh`. The index recommends; governance sets a floor; the PEP decides (FR-TR-2):
 * - entitled tier = max(recommended tier, governance tier `members.tier`);
 * - effective tier = max(entitled, highest tier of a VAC the member still holds, valid and unrevoked): downgrades
 *   apply at that VAC's expiry, never mid-round. With `downgradeAtExpiryOnly: false` in the signed policy,
 *   VACs above the entitled tier are revoked at once;
 * - upgrades apply immediately;
 * - the member always holds a fresh VAC at the entitled tier: one is issued when none is held at that tier or it
 *   expires within 7 days, so nothing is ever renewed above the entitlement;
 * - the PEP writes ONLY `members.effective_tier` / `effective_until`; `members.tier` is the governance record the
 *   trust index reads and is never written here.
 */
export async function refreshAuthorities(ctx: VtaContext, deps: Pick<PodVtaDeps, 'podSigner' | 'index'>, did: string): Promise<RefreshResult> {
  const [member] = await ctx.db.query<{ did: string; tier: string; ack: unknown; grant: unknown }>(
    'SELECT did, tier, ack, "grant" FROM members WHERE did = $1',
    [did],
  );
  if (!member || (member.grant && !member.ack)) {
    throw new ServiceError(403, 'NO_MEMBERSHIP', 'Only members of this pod can refresh their authorities.', 'Complete the membership ceremony first.');
  }
  const rec = await deps.index.recommendTier(ctx, did);
  const governance: Tier = isTier(member.tier) ? member.tier : 'T0';
  const entitled = maxTier(rec.tier, governance);
  const now = ctx.now().getTime();
  const explanation = [...rec.explanation];
  if (tierRank(governance) > tierRank(rec.tier)) explanation.push(`Pod governance has recorded you at tier ${governance}.`);
  const atExpiryOnly = ctx.policy.downgradeAtExpiryOnly !== false;

  let valid = await validVacs(ctx, did);
  const heldOf = (rows: VacLogRow[]) => rows.reduce<Tier>((t, r) => (isTier(r.tier) ? maxTier(t, r.tier) : t), 'T0');
  let held = heldOf(valid);

  if (!atExpiryOnly && tierRank(held) > tierRank(entitled)) {
    const above = valid.filter((r) => isTier(r.tier) && tierRank(r.tier) > tierRank(entitled));
    for (const r of above) {
      await ctx.db.query('UPDATE vac_issuance_log SET revoked_at = $2 WHERE id = $1', [r.id, ctx.now().toISOString()]);
    }
    explanation.push(`Your tier ${held} authority was withdrawn because this pod applies downgrades immediately.`);
    valid = valid.filter((r) => !above.includes(r));
    held = heldOf(valid);
  }

  const tier = maxTier(held, entitled);
  if (tierRank(held) > tierRank(entitled)) {
    const top = valid.find((r) => r.tier === held)!;
    explanation.push(
      `Your tier stays at ${held} until your current authority expires on ${toIso(top.valid_until)!.slice(0, 10)}; changes apply at expiry, never mid-round.`,
    );
  }

  let issued = false;
  if (entitled !== 'T0') {
    const atEntitled = valid.find((r) => r.tier === entitled);
    // A held VAC is also stale when policy now grants its tier more actions (e.g. `vwc:issue` at T2).
    const heldActions = atEntitled ? json<string[]>(atEntitled.actions) ?? [] : [];
    const complete = tierActions(ctx, entitled).every((a) => heldActions.includes(a));
    const fresh = atEntitled && complete && toMs(atEntitled.valid_until) - now >= REFRESH_WINDOW_DAYS * DAY_MS;
    if (!fresh) {
      const out = await issueAuthorities(ctx, deps, did, entitled, [`Refreshed: recommended ${rec.tier}, governance tier ${governance}.`]);
      issued = true;
      explanation.push(out.explanation[out.explanation.length - 1]!);
      valid = await validVacs(ctx, did);
    }
  }
  const carrying = valid.filter((r) => r.tier === tier).map((r) => toMs(r.valid_until));
  await setEffective(ctx, did, tier, carrying.length ? new Date(Math.max(...carrying)).toISOString() : null);
  return {
    tier,
    issued,
    vacs: valid.map((r) => json<VerifiableCredential>(r.credential)),
    explanation,
    ...(rec.next ? { next: rec.next } : {}),
  };
}

/** Appends one row to `governance_log` (migration 0007). */
export async function logGovernance(ctx: VtaContext, did: string, previous: string | null, next: Tier, by: string, reason: string): Promise<void> {
  await ctx.db.query(
    'INSERT INTO governance_log (subject_did, previous_tier, new_tier, by_did, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [did, previous, next, by, reason, ctx.now().toISOString()],
  );
}

/**
 * Operator/governance-body write of `members.tier`, unrestricted, always logged. Used by operator paths and
 * tests; stewards go through `stewardSetTier`.
 */
export async function recordGovernanceTier(ctx: VtaContext, did: string, tier: Tier, by: string, reason: string): Promise<{ did: string; tier: Tier; previous: string }> {
  if (!reason.trim()) throw new ServiceError(400, 'BAD_REQUEST', 'A governance decision needs a reason.');
  const [row] = await ctx.db.query<{ tier: string }>('SELECT tier FROM members WHERE did = $1', [did]);
  if (!row) throw new ServiceError(404, 'NOT_FOUND', 'There is no member with that DID in this pod.');
  await ctx.db.query('UPDATE members SET tier = $2 WHERE did = $1', [did, tier]);
  await logGovernance(ctx, did, row.tier, tier, by, reason.trim());
  return { did, tier, previous: row.tier };
}

const TIER_PROTECTED = 'Only governance can change the tier of a steward or anchor.';

/**
 * Steward governance write (`POST /steward/members/:did/tier`). A steward may set T0–T2, and only for members
 * whose governance tier is below T3 and below the steward's own tier; stewards and anchors (≥ T3) are protected
 * (403 `TIER_PROTECTED`). Raising anyone to T3 or above stays reserved for `bootstrapSteward` / operator paths
 * (`recordGovernanceTier`). Every change is logged with who, why and the previous tier.
 */
export async function stewardSetTier(
  ctx: VtaContext,
  did: string,
  tier: Tier,
  caller: { subject: string; tier?: string },
  reason: string,
): Promise<{ did: string; tier: Tier; previous: string }> {
  if (tierRank(tier) > tierRank('T2')) throw new ServiceError(403, 'TIER_PROTECTED', 'Raising a member to T3 or above is reserved for pod governance.');
  const callerTier: Tier = isTier(caller.tier) ? caller.tier : 'T0';
  const [row] = await ctx.db.query<{ tier: string }>('SELECT tier FROM members WHERE did = $1', [did]);
  if (!row) throw new ServiceError(404, 'NOT_FOUND', 'There is no member with that DID in this pod.');
  const current: Tier = isTier(row.tier) ? row.tier : 'T0';
  if (tierRank(current) >= tierRank('T3') || tierRank(current) >= tierRank(callerTier)) {
    throw new ServiceError(403, 'TIER_PROTECTED', TIER_PROTECTED);
  }
  return recordGovernanceTier(ctx, did, tier, caller.subject, reason);
}

export async function governanceLog(ctx: VtaContext) {
  const rows = await ctx.db.query<any>('SELECT * FROM governance_log ORDER BY id DESC LIMIT 500');
  return rows.map((r) => ({
    id: String(r.id),
    subject: r.subject_did,
    previousTier: r.previous_tier,
    newTier: r.new_tier,
    by: r.by_did,
    reason: r.reason,
    createdAt: toIso(r.created_at),
  }));
}

/** `POST /authority/revoke`: sets `revoked_at` on the log row whose credential digest is `digest`. */
export async function revokeAuthority(ctx: VtaContext, digest: string, reason: string, by: string): Promise<{ id: string; revokedAt: string }> {
  const rows = await ctx.db.query<{ id: string | number; credential: unknown; revoked_at: unknown }>(
    'SELECT id, credential, revoked_at FROM vac_issuance_log WHERE credential IS NOT NULL ORDER BY id DESC',
  );
  const hit = rows.find((r) => digestMultibase(json(r.credential)) === digest);
  if (!hit) throw new ServiceError(404, 'NOT_FOUND', 'No authority credential issued by this pod has that digest.');
  const revokedAt = toIso(hit.revoked_at) ?? ctx.now().toISOString();
  if (!hit.revoked_at) {
    await ctx.db.query(
      `UPDATE vac_issuance_log SET revoked_at = $2,
              explanation = COALESCE(explanation, '[]'::jsonb) || $3::jsonb
        WHERE id = $1`,
      [hit.id, revokedAt, JSON.stringify([`Revoked by ${by}: ${reason}`])],
    );
  }
  return { id: String(hit.id), revokedAt };
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array> }).CompressionStream;
  if (!CS) return null;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CS('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * `GET /status/:list` — a VC 2.0 BitstringStatusListCredential for the pod's VACs, signed by the pod.
 * Bit index = `vac_issuance_log.id` (most significant bit first); a bit is set when the row has `revoked_at`.
 * `encodedList` = multibase `u` + base64url(gzip(bitstring)) when `CompressionStream` exists (Node ≥ 18,
 * browsers); otherwise the raw bitstring is base64url-encoded and `encoding: 'raw'` is added (the verifier
 * SDK detects gzip by magic bytes, so both decode). Kept deliberately simple: one list per pod, rebuilt on
 * every request.
 */
export async function statusListCredential(ctx: VtaContext, deps: Pick<PodVtaDeps, 'podSigner'>, list: string) {
  if (list !== VAC_STATUS_LIST) throw new ServiceError(404, 'NOT_FOUND', `This pod publishes no status list called "${list}".`);
  const rows = await ctx.db.query<{ id: string | number; revoked: boolean }>(
    'SELECT id, (revoked_at IS NOT NULL) AS revoked FROM vac_issuance_log',
  );
  const maxId = rows.reduce((m, r) => Math.max(m, Number(r.id)), 0);
  const bits = Math.max(MIN_STATUS_BITS, Math.ceil((maxId + 1) / 8) * 8);
  const bytes = new Uint8Array(bits / 8);
  for (const r of rows) {
    if (!r.revoked) continue;
    const i = Number(r.id);
    bytes[Math.floor(i / 8)]! |= 1 << (7 - (i % 8));
  }
  const zipped = await gzip(bytes);
  const url = statusListUrl(ctx, list);
  const now = ctx.now().toISOString();
  const doc = {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: url,
    type: ['VerifiableCredential', 'BitstringStatusListCredential'],
    issuer: ctx.podDid,
    validFrom: now,
    credentialSubject: {
      id: `${url}#list`,
      type: 'BitstringStatusList',
      statusPurpose: 'revocation',
      encodedList: 'u' + base64urlnopad.encode(zipped ?? bytes),
      ...(zipped ? {} : { encoding: 'raw' }),
    },
  };
  return deps.podSigner.sign(doc, { created: now });
}
