import { buildAuthority, digestMultibase, type VerifiableCredential } from '@passport/credential-core';
import { MAX_VALIDITY_DAYS } from '@passport/credential-core';
import { base64urlnopad } from '@scure/base';
import { ServiceError } from '@passport/service-kit';
import { tierDefaultActions, tierRank, TIERS, type Tier } from '@passport/vocab';
import type { PodVtaDeps, VtaContext } from './types.js';
import { addDays, DAY_MS, json, toIso, toMs } from './util.js';

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
 * PEP issuance. Issues ONE root AuthorityCredential (VAC) scoped to the pod and carrying every default action
 * of `tier` (`tierDefaultActions`), rather than one VAC per action: fewer credentials to hold and present, and
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
  const actions = tierDefaultActions(tier);
  if (!actions.length) return { vacs: [], explanation: [...explanation, `Tier ${tier} carries no authorities, so none were issued.`] };
  const now = ctx.now();
  const validFrom = now.toISOString();
  const days = Math.min(ctx.policy.vacValidityDays, MAX_VALIDITY_DAYS.authority);
  const validUntil = addDays(now, days);
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
  const vac = deps.podSigner.sign(unsigned, { created: validFrom });
  await ctx.db.query('UPDATE vac_issuance_log SET credential = $2 WHERE id = $1', [id, JSON.stringify(vac)]);
  return { vacs: [vac], explanation: lines };
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
 * `POST /authority/refresh`. The index recommends; the PEP decides (FR-TR-2):
 * - the effective tier never drops below the highest tier of a VAC the member still holds (valid, unrevoked):
 *   downgrades apply at that VAC's expiry, never mid-round. With `downgradeAtExpiryOnly: false` in the signed
 *   policy the recommendation applies at once and higher-tier VACs are revoked;
 * - upgrades apply immediately;
 * - the PEP keeps the member holding a fresh VAC at the recommended tier: one is issued when none is held at
 *   that tier or the held one expires within 7 days (so a pending downgrade gets its lower-tier VAC ahead of
 *   the higher one's expiry, and nothing is ever renewed above the recommendation);
 * - `members.tier` records the effective tier.
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
  const now = ctx.now().getTime();
  const explanation = [...rec.explanation];
  const atExpiryOnly = ctx.policy.downgradeAtExpiryOnly !== false;

  let valid = await validVacs(ctx, did);
  const heldOf = (rows: VacLogRow[]) => rows.reduce<Tier>((t, r) => (isTier(r.tier) ? maxTier(t, r.tier) : t), 'T0');
  let held = heldOf(valid);

  if (!atExpiryOnly && tierRank(held) > tierRank(rec.tier)) {
    const above = valid.filter((r) => isTier(r.tier) && tierRank(r.tier) > tierRank(rec.tier));
    for (const r of above) {
      await ctx.db.query('UPDATE vac_issuance_log SET revoked_at = $2 WHERE id = $1', [r.id, ctx.now().toISOString()]);
    }
    explanation.push(`Your tier ${held} authority was withdrawn because this pod applies downgrades immediately.`);
    valid = valid.filter((r) => !above.includes(r));
    held = heldOf(valid);
  }

  const tier = maxTier(held, rec.tier);
  if (tierRank(held) > tierRank(rec.tier)) {
    const top = valid.find((r) => r.tier === held)!;
    explanation.push(
      `Your tier stays at ${held} until your current authority expires on ${toIso(top.valid_until)!.slice(0, 10)}; changes apply at expiry, never mid-round.`,
    );
  }

  let issued = false;
  if (rec.tier !== 'T0') {
    const atRec = valid.find((r) => r.tier === rec.tier);
    const fresh = atRec && toMs(atRec.valid_until) - now >= REFRESH_WINDOW_DAYS * DAY_MS;
    if (!fresh) {
      const out = await issueAuthorities(ctx, deps, did, rec.tier, [`Refreshed from the trust index recommendation (${rec.tier}).`]);
      issued = true;
      explanation.push(out.explanation[out.explanation.length - 1]!);
      valid = await validVacs(ctx, did);
    }
  }
  if (tier !== member.tier) {
    await ctx.db.query('UPDATE members SET tier = $2 WHERE did = $1', [did, tier]);
  }
  return {
    tier,
    issued,
    vacs: valid.map((r) => json<VerifiableCredential>(r.credential)),
    explanation,
    ...(rec.next ? { next: rec.next } : {}),
  };
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
