/**
 * Merchant Mode back end (FR-CI-4, FR-CI-6): enterprises, acceptance rules, staff, commitments.
 *
 * Ruling: an enterprise's DID is a gateway-minted `did:key` whose private key is discarded. The enterprise never
 * signs anything itself; people act for it through `pay:receive` authority scoped to that DID — a root VAC the
 * pod issues to the owner, attenuated by the owner (in the wallet, with the owner's key) to staff for ≤ 30 days.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  buildAuthority,
  checkAuthorityChain,
  digestMultibase,
  generateKeyPair,
  MAX_VALIDITY_DAYS,
  verifyDocument,
  type DataIntegrityProof,
  type VerifiableCredential,
} from '@passport/credential-core';
import { EnterpriseRecordSchema, recordUri } from '@passport/lexicons';
import { json, merchantScope, num, toIso } from '@passport/pos-adapter';
import { ServiceError, type SessionClaims } from '@passport/service-kit';
import { accountView, DEFAULT_CEILING_SHARE, ENTERPRISE_LIMIT_FACTOR, highestBand, openAccount, type AccountRow } from './ledger.js';
import { addMs, atLeast, bad, cents, DAY_MS, isObject, optString, sessionTier, type GatewayContext, type GatewayDeps } from './util.js';

export const ACCEPTANCE_CATEGORIES = ['services', 'suppliers', 'retail'] as const;
export type AcceptanceCategory = (typeof ACCEPTANCE_CATEGORIES)[number];

export const MERCHANT_VAC_DAYS = MAX_VALIDITY_DAYS.authority; // 90
export const STAFF_MAX_DAYS = MAX_VALIDITY_DAYS.attenuatedAuthority; // 30

export interface EnterpriseRow {
  did: string;
  name: string;
  categories: unknown;
  accepts_local_credit: boolean;
  acceptance_share: string | number | null;
  steward_dids: unknown;
  place_id: string | null;
  owner_did: string | null;
  record: unknown;
}

export interface Rules {
  maxShare: number;
  category: AcceptanceCategory | string;
  minSale: number;
  ceiling: number;
  offlineAllowance: number;
}

/** Status-list URL of the pod VTA (same list the VTA serves; the merchant root VAC is logged in `vac_issuance_log`). */
const statusListUrl = (ctx: GatewayContext) => `https://${ctx.slug}.${ctx.platformDomain}/api/vta/status/vac`;

/** Deterministic record key for an enterprise's open record, so rule changes update the same record. */
export const enterpriseRkey = (did: string): string => bytesToHex(sha256(utf8ToBytes(did))).slice(0, 16);

export async function getEnterprise(ctx: GatewayContext, did: string): Promise<EnterpriseRow> {
  const [row] = await ctx.db.query<EnterpriseRow>('SELECT * FROM enterprises WHERE did = $1', [did]);
  if (!row) throw new ServiceError(404, 'NO_ENTERPRISE', 'There is no enterprise with that identifier in this pod.');
  return row;
}

export async function getRules(ctx: GatewayContext, did: string): Promise<Rules> {
  const [row] = await ctx.db.query<{ rules: unknown; ceiling: unknown; offline_allowance: unknown }>(
    'SELECT rules, ceiling, offline_allowance FROM acceptance_rules WHERE enterprise_did = $1',
    [did],
  );
  if (!row) throw new ServiceError(404, 'NO_RULES', 'This enterprise has not set acceptance rules yet.');
  const r = json<Record<string, any>>(row.rules) ?? {};
  return {
    maxShare: Number(r['maxShare'] ?? 0),
    category: String(r['category'] ?? 'retail'),
    minSale: Number(r['minSale'] ?? 0),
    ceiling: num(row.ceiling),
    offlineAllowance: num(row.offline_allowance),
  };
}

export function requireOwner(e: EnterpriseRow, s: SessionClaims): void {
  if (e.owner_did !== s.subject) throw new ServiceError(403, 'NOT_OWNER', 'Only the owner of this enterprise can do this.');
}

const nonNegative = (v: unknown, what: string): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad('BAD_REQUEST', `${what} must be a number of zero or more.`);
  return v;
};

async function writeEnterpriseRecord(ctx: GatewayContext, e: { did: string; owner: string; record: Record<string, unknown> }) {
  const record = EnterpriseRecordSchema.parse({ ...e.record, bioregion: ctx.slug });
  const uri = recordUri(ctx.slug, 'enterprise', enterpriseRkey(e.did));
  const now = ctx.now().toISOString();
  await ctx.db.query(
    `INSERT INTO records (uri, collection, bioregion, place_id, author_did, record, created_at, updated_at)
       VALUES ($1, 'enterprise', $2, $3, $4, $5::jsonb, $6, $6)
     ON CONFLICT (uri) DO UPDATE SET place_id = excluded.place_id, record = excluded.record, updated_at = excluded.updated_at`,
    [uri, ctx.slug, record.placeId ?? null, e.owner, JSON.stringify(record), now],
  );
  await ctx.db.query('UPDATE enterprises SET record = $2::jsonb WHERE did = $1', [e.did, JSON.stringify(record)]);
  return { uri, record };
}

/**
 * `POST /merchant/enterprises`. Enterprise account limit = owner's band limit × 3; default acceptance ceiling =
 * 80% of that. Returns the owner's root `pay:receive` VAC (90 days) for the wallet to store.
 */
export async function createEnterprise(ctx: GatewayContext, deps: GatewayDeps, s: SessionClaims, body: unknown) {
  if (!atLeast(s, 'T1')) throw new ServiceError(403, 'TIER_TOO_LOW', 'Opening an enterprise needs tier T1 or higher.');
  if (!isObject(body)) throw bad('BAD_REQUEST', 'An enterprise needs a name, categories and an acceptance category.');
  const name = optString(body['name']);
  if (!name) throw bad('BAD_REQUEST', 'An enterprise needs a name.');
  const categories = body['categories'];
  if (!Array.isArray(categories) || !categories.length || !categories.every((c) => typeof c === 'string' && c.trim())) {
    throw bad('BAD_REQUEST', 'An enterprise needs at least one category.');
  }
  const acceptanceCategory = body['acceptanceCategory'];
  if (typeof acceptanceCategory !== 'string' || !(ACCEPTANCE_CATEGORIES as readonly string[]).includes(acceptanceCategory)) {
    throw bad('BAD_REQUEST', `The acceptance category must be one of ${ACCEPTANCE_CATEGORIES.join(', ')}.`);
  }
  const lat = body['lat'];
  const lon = body['lon'];
  if ((lat !== undefined && typeof lat !== 'number') || (lon !== undefined && typeof lon !== 'number')) {
    throw bad('BAD_REQUEST', 'Latitude and longitude must be numbers.');
  }
  const ceilingIn = nonNegative(body['ceiling'], 'The ceiling');
  const offlineIn = nonNegative(body['offlineAllowance'], 'The offline allowance');

  const currency = ctx.manifest.currency;
  const band = highestBand(s.authorities);
  const limit = cents(currency.limits[band] * ENTERPRISE_LIMIT_FACTOR);
  const ceiling = cents(ceilingIn ?? DEFAULT_CEILING_SHARE * limit);
  const offlineAllowance = cents(offlineIn ?? currency.offlineAllowancePerDay);
  const maxShare = currency.defaultAcceptance[acceptanceCategory as AcceptanceCategory];
  const did = generateKeyPair().did; // key material discarded by design (see module doc)
  const placeId = optString(body['placeId']);
  const description = optString(body['description']);

  const enterpriseRecord = {
    name,
    categories: categories.map((c: string) => c.trim()),
    acceptsLocalCredit: true,
    acceptanceShare: maxShare,
    stewardDids: [s.subject],
    did,
    ...(placeId ? { placeId } : {}),
    ...(description ? { description } : {}),
    ...(typeof lat === 'number' ? { lat } : {}),
    ...(typeof lon === 'number' ? { lon } : {}),
  };
  await ctx.db.query(
    `INSERT INTO enterprises (did, name, categories, accepts_local_credit, acceptance_share, steward_dids, place_id, owner_did, record)
     VALUES ($1, $2, $3::jsonb, true, $4, $5::jsonb, $6, $7, NULL)`,
    [did, name, JSON.stringify(enterpriseRecord.categories), maxShare, JSON.stringify([s.subject]), placeId ?? null, s.subject],
  );
  await ctx.db.query(
    `INSERT INTO acceptance_rules (enterprise_did, rules, ceiling, offline_allowance) VALUES ($1, $2::jsonb, $3, $4)`,
    [did, JSON.stringify({ maxShare, category: acceptanceCategory, minSale: 0 }), ceiling, offlineAllowance],
  );
  const { account } = await openAccount(ctx, { did, kind: 'enterprise', band, limit });
  const { uri } = await writeEnterpriseRecord(ctx, { did, owner: s.subject, record: enterpriseRecord });

  // Root pay:receive VAC for the owner, logged like every other VAC so the VTA status list can revoke it.
  const now = ctx.now();
  const validFrom = now.toISOString();
  const validUntil = addMs(now, MERCHANT_VAC_DAYS * DAY_MS);
  const tier = sessionTier(s);
  const [log] = await ctx.db.query<{ id: string | number }>(
    `INSERT INTO vac_issuance_log (subject_did, actions, tier, policy_version, explanation, issued_at, valid_until)
     VALUES ($1, $2::jsonb, $3, $4, $5::jsonb, $6, $7) RETURNING id`,
    [
      s.subject,
      JSON.stringify(['pay:receive']),
      tier,
      ctx.policy.version,
      JSON.stringify([`Authority to receive payments at ${name} (${did}), issued to its owner.`]),
      validFrom,
      validUntil,
    ],
  );
  const logId = String(log!.id);
  const unsigned = buildAuthority({ issuer: ctx.podDid, subject: s.subject, scope: did, actions: ['pay:receive'], validFrom, validUntil, tier, policyVersion: ctx.policy.version });
  unsigned.credentialStatus = {
    id: `${statusListUrl(ctx)}#${logId}`,
    type: 'BitstringStatusListEntry',
    statusPurpose: 'revocation',
    statusListIndex: logId,
    statusListCredential: statusListUrl(ctx),
  };
  const vac = deps.podSigner.sign(unsigned, { created: validFrom });
  await ctx.db.query('UPDATE vac_issuance_log SET credential = $2::jsonb WHERE id = $1', [logId, JSON.stringify(vac)]);

  return {
    enterprise: {
      did,
      name,
      uri,
      categories: enterpriseRecord.categories,
      owner: s.subject,
      rules: { maxShare, category: acceptanceCategory, minSale: 0, ceiling, offlineAllowance },
      account: accountView(ctx, account),
    },
    vac,
  };
}

/** `PUT /merchant/enterprises/:did/rules` (owner). */
export async function updateRules(ctx: GatewayContext, s: SessionClaims, did: string, body: unknown) {
  const e = await getEnterprise(ctx, did);
  requireOwner(e, s);
  if (!isObject(body)) throw bad('BAD_REQUEST', 'Rules need a maximum share, a ceiling or an offline allowance.');
  const current = await getRules(ctx, did);
  const maxShare = body['maxShare'];
  if (maxShare !== undefined && (typeof maxShare !== 'number' || !(maxShare >= 0 && maxShare <= 1))) {
    throw bad('BAD_REQUEST', 'The maximum credit share must be between 0 and 1.');
  }
  const ceiling = nonNegative(body['ceiling'], 'The ceiling');
  const offline = nonNegative(body['offlineAllowance'], 'The offline allowance');
  const minSale = nonNegative(body['minSale'], 'The minimum sale');
  const next: Rules = {
    maxShare: typeof maxShare === 'number' ? maxShare : current.maxShare,
    category: current.category,
    minSale: minSale ?? current.minSale,
    ceiling: cents(ceiling ?? current.ceiling),
    offlineAllowance: cents(offline ?? current.offlineAllowance),
  };
  await ctx.db.query('UPDATE acceptance_rules SET rules = $2::jsonb, ceiling = $3, offline_allowance = $4 WHERE enterprise_did = $1', [
    did,
    JSON.stringify({ maxShare: next.maxShare, category: next.category, minSale: next.minSale }),
    next.ceiling,
    next.offlineAllowance,
  ]);
  await ctx.db.query('UPDATE enterprises SET acceptance_share = $2 WHERE did = $1', [did, next.maxShare]);
  const record = e.record ? json<Record<string, unknown>>(e.record) : null;
  if (record) await writeEnterpriseRecord(ctx, { did, owner: e.owner_did ?? s.subject, record: { ...record, acceptanceShare: next.maxShare } });
  return { rules: next };
}

/** The owner's current root `pay:receive` VACs for an enterprise (newest first). */
async function ownerRootVacs(ctx: GatewayContext, owner: string, enterpriseDid: string): Promise<VerifiableCredential[]> {
  const rows = await ctx.db.query<{ credential: unknown }>(
    `SELECT credential FROM vac_issuance_log
      WHERE subject_did = $1 AND revoked_at IS NULL AND credential IS NOT NULL
        AND credential->'credentialSubject'->'authority'->>'scope' = $2
      ORDER BY issued_at DESC, id DESC`,
    [owner, enterpriseDid],
  );
  return rows.map((r) => json<VerifiableCredential>(r.credential));
}

/**
 * `POST /merchant/enterprises/:did/staff` (owner) `{ vac, staffDid? }`: the owner attenuates their root VAC in
 * the wallet (only the wallet holds the owner's key); the gateway checks the signature and the chain against the
 * logged root and records the grant so the owner can list and revoke staff.
 */
export async function addStaff(ctx: GatewayContext, deps: GatewayDeps, s: SessionClaims, did: string, body: unknown) {
  const e = await getEnterprise(ctx, did);
  requireOwner(e, s);
  const vac = isObject(body) ? (body['vac'] as VerifiableCredential | undefined) : undefined;
  if (!isObject(vac) || !isObject(vac.credentialSubject) || !isObject(vac.proof)) {
    throw bad('BAD_REQUEST', 'Adding staff needs the authority credential you signed for them.');
  }
  const staffDid = vac.credentialSubject.id;
  if (typeof staffDid !== 'string' || !staffDid.startsWith('did:')) throw bad('BAD_REQUEST', 'The staff credential does not name a staff member.');
  const claimed = isObject(body) ? body['staffDid'] : undefined;
  if (claimed !== undefined && claimed !== staffDid) throw bad('STAFF_MISMATCH', 'The staff credential names a different person than the one you asked to add.');
  if (vac.issuer !== s.subject) throw new ServiceError(403, 'NOT_OWNER', 'A staff credential must be signed by the enterprise owner.');
  const sig = await verifyDocument(vac as VerifiableCredential & { proof: DataIntegrityProof }, deps.resolver, { proofPurpose: 'assertionMethod' });
  if (!sig.ok) throw bad('BAD_PROOF', `The staff credential's signature did not check out (${sig.error ?? 'unknown error'}).`);
  const authority = vac.credentialSubject['authority'];
  if (!isObject(authority) || authority['scope'] !== did || !Array.isArray(authority['actions']) || !authority['actions'].includes('pay:receive')) {
    throw bad('BAD_CHAIN', 'The staff credential does not pass on authority to receive payments at this enterprise.');
  }
  const roots = await ownerRootVacs(ctx, s.subject, did);
  const root = roots.find((r) => digestMultibase(r) === authority['parent']);
  if (!root) throw bad('BAD_CHAIN', 'The staff credential does not come from your current authority for this enterprise.');
  const chain = checkAuthorityChain([root, vac]);
  if (!chain.ok) throw bad('BAD_CHAIN', chain.reason ?? 'The staff credential goes beyond the authority it came from.');
  const now = ctx.now().getTime();
  const until = Date.parse(vac.validUntil ?? '');
  if (Number.isNaN(until) || until <= now) throw bad('EXPIRED', 'The staff credential has already expired.');
  if (until - Date.parse(vac.validFrom) > STAFF_MAX_DAYS * DAY_MS || until - now > STAFF_MAX_DAYS * DAY_MS) {
    throw bad('TOO_LONG', `Staff authority may last at most ${STAFF_MAX_DAYS} days.`);
  }
  const digest = digestMultibase(vac);
  const validUntil = new Date(until).toISOString();
  await ctx.db.query(
    `INSERT INTO merchant_staff (enterprise_did, staff_did, vac_digest, valid_until, created_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (enterprise_did, staff_did, vac_digest) DO NOTHING`,
    [did, staffDid, digest, validUntil, ctx.now().toISOString()],
  );
  return { staff: { enterpriseDid: did, staffDid, digest, validUntil } };
}

/** `DELETE /merchant/enterprises/:did/staff/:staffDid` (owner): revokes every grant to that staff member. */
export async function revokeStaff(ctx: GatewayContext, s: SessionClaims, did: string, staffDid: string) {
  const e = await getEnterprise(ctx, did);
  requireOwner(e, s);
  const rows = await ctx.db.query(
    'UPDATE merchant_staff SET revoked_at = $3 WHERE enterprise_did = $1 AND staff_did = $2 AND revoked_at IS NULL RETURNING staff_did',
    [did, staffDid, ctx.now().toISOString()],
  );
  if (!rows.length) throw new ServiceError(404, 'NOT_FOUND', 'That person is not current staff of this enterprise.');
  return { revoked: rows.length };
}

/** `POST /merchant/commitment` (owner): the FR-CI-6 commitment record. */
export async function addCommitment(ctx: GatewayContext, s: SessionClaims, body: unknown) {
  const did = isObject(body) ? body['enterpriseDid'] : undefined;
  const text = isObject(body) ? optString(body['text']) : undefined;
  if (typeof did !== 'string' || !text) throw bad('BAD_REQUEST', 'A commitment needs the enterprise and what it commits to.');
  requireOwner(await getEnterprise(ctx, did), s);
  const [row] = await ctx.db.query<any>('INSERT INTO commitments (enterprise_did, text, signed_at) VALUES ($1, $2, $3) RETURNING *', [
    did,
    text,
    ctx.now().toISOString(),
  ]);
  return { commitment: { id: String(row.id), enterpriseDid: did, text, signedAt: toIso(row.signed_at) } };
}

/** `GET /merchant/enterprises/mine`: enterprises the session owns or staffs, with rules and exposure. */
export async function listMine(ctx: GatewayContext, s: SessionClaims) {
  const dids = await merchantScope(ctx, s);
  const out = [];
  for (const did of dids) {
    const e = await getEnterprise(ctx, did);
    const rules = await getRules(ctx, did).catch(() => null);
    const [acct] = await ctx.db.query<AccountRow>('SELECT * FROM accounts WHERE did = $1', [did]);
    const [commitment] = await ctx.db.query<any>('SELECT * FROM commitments WHERE enterprise_did = $1 ORDER BY signed_at DESC, id DESC LIMIT 1', [did]);
    const owner = e.owner_did === s.subject;
    const staff = owner
      ? (
          await ctx.db.query<any>('SELECT * FROM merchant_staff WHERE enterprise_did = $1 ORDER BY created_at DESC', [did])
        ).map((r) => ({ staffDid: r.staff_did, digest: r.vac_digest, validUntil: toIso(r.valid_until), revokedAt: toIso(r.revoked_at) }))
      : undefined;
    const balance = acct ? num(acct.balance) : 0;
    const ceiling = rules?.ceiling ?? 0;
    out.push({
      did,
      name: e.name,
      role: owner ? 'owner' : 'staff',
      categories: json(e.categories),
      rules,
      account: acct ? accountView(ctx, acct) : null,
      exposure: { balance, ceiling, pct: ceiling > 0 ? Math.round((balance / ceiling) * 1000) / 1000 : 0 },
      commitment: commitment ? { id: String(commitment.id), text: commitment.text, signedAt: toIso(commitment.signed_at) } : null,
      ...(staff ? { staff } : {}),
    });
  }
  return { enterprises: out };
}
