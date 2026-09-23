import {
  buildMembershipGrant,
  digestMultibase,
  isMembershipPairComplete,
  MAX_VALIDITY_DAYS,
  verifyDocument,
  type DataIntegrityProof,
  type VerifiableCredential,
} from '@passport/credential-core';
import { ServiceError } from '@passport/service-kit';
import { tierRank, TIERS, type Tier } from '@passport/vocab';
import { canWitnessAt, getEventRow } from './events.js';
import { issueAuthorities, setEffective } from './pep.js';
import type { PodVtaDeps, VtaContext } from './types.js';
import { bad, isObject, json, toIso, toMs, validityWindow } from './util.js';

const WITNESS_INVALID = 'Admission needs a witness credential from one of this pod\'s attestation events.';

export interface MemberRow {
  did: string;
  /** Governance tier (bootstrap, steward/operator decisions, the T1 admission floor). Never written by the PEP. */
  tier: string;
  vmc_grant_digest: string | null;
  vmc_ack_digest: string | null;
  grant: unknown;
  ack: unknown;
  valid_until: unknown;
  joined_at: unknown;
  /** PEP decision (migration 0006). */
  effective_tier: string | null;
  effective_until: unknown;
}

const isType = (vc: any, t: string) => Array.isArray(vc?.type) && vc.type.includes('VerifiableCredential') && vc.type.includes(t);

function witnessInvalid(detail?: string): ServiceError {
  return new ServiceError(403, 'WITNESS_INVALID', WITNESS_INVALID, detail);
}
const EDGE_NOT_YOURS = 'This witness credential is for a relationship you are not part of.';
const edgeNotYours = (detail?: string) => new ServiceError(403, 'EDGE_NOT_YOURS', EDGE_NOT_YOURS, detail);
const witnessUsed = () =>
  new ServiceError(403, 'WITNESS_USED', 'This witness credential has already admitted both people in its relationship.');

export interface WitnessCheck {
  eventId: string;
  placeId: string | null;
  /** digestMultibase(vwc) — the `witness_refs` key. */
  digest: string;
  /** The two parties of the witnessed edge (VRC issuer + subject, equal to the VWC's `edgeParties`). */
  parties: [string, string];
  usedBy: string[];
}

/**
 * Checks a VWC for admission (FR-TR-3) and binds it to the applicant:
 * - signed by this pod (the VTA issues VWCs on behalf of conveners), a `dtg:witnessed` statement, unexpired,
 *   whose `taskContext` names one of this pod's attestation events with the same task digest, and recorded in
 *   `witness_refs`;
 * - the witnessing convener held an unrevoked VAC with `vwc:issue` that was valid when the VWC was issued;
 * - the presentation carries a signed RelationshipCredential whose digest is the witnessed edge digest and in
 *   which the holder is issuer or subject; its parties must equal the VWC's `edgeParties` (else `EDGE_NOT_YOURS`);
 * - the VWC admits at most its two edge parties (`witness_refs.used_by`, else `WITNESS_USED`).
 */
export async function checkWitness(
  ctx: VtaContext,
  deps: Pick<PodVtaDeps, 'resolver'>,
  vwc: unknown,
  presentation: Record<string, any>,
  holder: string,
): Promise<WitnessCheck> {
  if (!isObject(vwc) || !isType(vwc, 'StatementCredential') || !vwc['proof']) throw witnessInvalid('The witness credential is missing or unsigned.');
  const cred = vwc as unknown as VerifiableCredential & { proof: DataIntegrityProof };
  if (cred.issuer !== ctx.podDid) throw witnessInvalid('The witness credential was not issued by this pod.');
  const subject = cred.credentialSubject ?? ({} as Record<string, any>);
  if (subject['predicate'] !== 'dtg:witnessed') throw witnessInvalid('The credential is not a witness statement.');
  const check = await verifyDocument(cred, deps.resolver, { proofPurpose: 'assertionMethod' });
  if (!check.ok) throw witnessInvalid(`The witness credential signature did not check out (${check.error}).`);
  const now = ctx.now().getTime();
  if (Date.parse(cred.validFrom) > now || !cred.validUntil || Date.parse(cred.validUntil) <= now) throw witnessInvalid('The witness credential is not currently valid.');
  if (typeof subject.id === 'string' && subject.id.startsWith('did:') && subject.id !== holder) {
    throw edgeNotYours('The witness credential names someone else.');
  }
  const parties = subject['edgeParties'];
  if (!Array.isArray(parties) || parties.length !== 2 || !parties.every((d) => typeof d === 'string' && d.startsWith('did:'))) {
    throw witnessInvalid('The witness credential does not name the two people in the relationship.');
  }
  const eventId = subject['taskContext'];
  const event = typeof eventId === 'string' ? await getEventRow(ctx, eventId) : undefined;
  if (!event || !canWitnessAt(event)) throw witnessInvalid('The witness credential does not name an attestation event of this pod.');
  if (event.task_digest !== subject['taskDigestMultibase']) throw witnessInvalid('The witness credential does not match the event\'s task document.');
  const digest = digestMultibase(cred);
  const [ref] = await ctx.db.query<{ convener_did: string | null; created_at: unknown; used_by: unknown }>(
    'SELECT convener_did, created_at, used_by FROM witness_refs WHERE digest = $1 AND event_id = $2',
    [digest, event.id],
  );
  if (!ref) throw witnessInvalid('This pod has no record of issuing that witness credential.');

  // Re-check the convener: an unrevoked VAC carrying vwc:issue, valid when the VWC was issued.
  const witnessedAt = toIso(ref.created_at);
  const authority = await ctx.db.query(
    `SELECT 1 FROM vac_issuance_log
      WHERE subject_did = $1 AND actions @> '["vwc:issue"]'::jsonb AND credential IS NOT NULL
        AND revoked_at IS NULL AND issued_at <= $2 AND valid_until > $2
      LIMIT 1`,
    [ref.convener_did, witnessedAt],
  );
  if (!authority.length) throw witnessInvalid('The convener who witnessed this no longer holds the authority to witness.');

  // Bind the witnessed edge to the applicant through the relationship credential they hold.
  const edgeDigest = subject['object']?.['digestMultibase'];
  const creds: unknown[] = Array.isArray(presentation['verifiableCredential']) ? presentation['verifiableCredential'] : [];
  const vrc = creds.find(
    (c): c is VerifiableCredential & { proof: DataIntegrityProof } =>
      isObject(c) &&
      isType(c, 'RelationshipCredential') &&
      !!c['proof'] &&
      typeof edgeDigest === 'string' &&
      digestMultibase(c) === edgeDigest &&
      ((c as any).issuer === holder || (c as any).credentialSubject?.id === holder),
  );
  if (!vrc) throw edgeNotYours('Include the relationship credential that was witnessed.');
  const vrcCheck = await verifyDocument(vrc, deps.resolver, { proofPurpose: 'assertionMethod' });
  if (!vrcCheck.ok) throw edgeNotYours(`The relationship credential signature did not check out (${vrcCheck.error}).`);
  const vrcParties = [vrc.issuer, vrc.credentialSubject.id].sort();
  const vwcParties = [...(parties as string[])].sort();
  if (vrcParties[0] !== vwcParties[0] || vrcParties[1] !== vwcParties[1]) {
    throw edgeNotYours('The relationship credential does not match the people the convener witnessed.');
  }

  const usedBy = (json<string[]>(ref.used_by) ?? []).filter((d) => typeof d === 'string');
  if (!usedBy.includes(holder) && (usedBy.length >= 2 || !vrcParties.includes(holder))) throw witnessUsed();
  return { eventId: event.id, placeId: event.place_id, digest, parties: [vwcParties[0]!, vwcParties[1]!], usedBy };
}

export async function getMember(ctx: VtaContext, did: string): Promise<MemberRow | undefined> {
  const rows = await ctx.db.query<MemberRow>('SELECT * FROM members WHERE did = $1', [did]);
  return rows[0];
}

/**
 * `POST /membership/apply` after the challenge is consumed. `presentation` proves control of the applicant's
 * directed persona DID (holder, proofPurpose authentication, bound to the challenge/domain); it may carry the
 * VRC half the applicant holds (kept for the audit trail only). Idempotent: an applicant who already holds an
 * unexpired grant gets it back.
 */
export async function applyMembership(
  ctx: VtaContext,
  deps: Pick<PodVtaDeps, 'podSigner' | 'resolver'>,
  body: unknown,
  binding: { challenge: string; domain: string },
): Promise<{ grant: VerifiableCredential; existing: boolean }> {
  if (!isObject(body)) throw bad('BAD_REQUEST', 'An application needs a witness credential and a signed presentation.');
  const vp = body['presentation'];
  if (!isObject(vp) || typeof vp['holder'] !== 'string' || !vp['proof']) throw bad('BAD_PROOF', 'The application must include a presentation signed by the applicant.');
  const proofCheck = await verifyDocument(vp as { proof: DataIntegrityProof }, deps.resolver, {
    proofPurpose: 'authentication',
    challenge: binding.challenge,
    domain: binding.domain,
  });
  if (!proofCheck.ok) throw bad('BAD_PROOF', 'The applicant\'s signature on the presentation did not check out.', proofCheck.error);
  const holder = vp['holder'] as string;

  const witness = await checkWitness(ctx, deps, body['vwc'], vp, holder);

  const existing = await getMember(ctx, holder);
  const now = ctx.now();
  if (existing?.grant) {
    const grant = json<VerifiableCredential>(existing.grant);
    if (grant.validUntil && Date.parse(grant.validUntil) > now.getTime()) return { grant, existing: true };
  }

  const window = validityWindow(now, ctx.policy.grantValidityDays, MAX_VALIDITY_DAYS.membership);
  const unsigned = buildMembershipGrant({
    pod: ctx.podDid,
    member: holder,
    bioregion: ctx.slug,
    placeIds: [witness.placeId ?? ctx.manifest.place.bioregionPolygon ?? `bioregion:${ctx.slug}`],
    governance: ctx.manifest.governance.url,
    validFrom: window.validFrom,
    validUntil: window.validUntil,
  });
  const grant = deps.podSigner.sign(unsigned, { created: now.toISOString() });
  const grantDigest = digestMultibase(grant);
  if (!witness.usedBy.includes(holder)) {
    // Atomic: at most two DIDs per VWC, each once.
    const marked = await ctx.db.query(
      `UPDATE witness_refs SET used_by = used_by || to_jsonb($2::text)
        WHERE digest = $1 AND NOT (used_by ? $2) AND jsonb_array_length(used_by) < 2
        RETURNING digest`,
      [witness.digest, holder],
    );
    if (!marked.length) throw witnessUsed();
  }
  // Pending row: governance tier T0 until the ack completes the pair (a re-applying former member keeps their
  // governance tier; their effective tier is re-decided at the ack).
  await ctx.db.query(
    `INSERT INTO members (did, tier, vmc_grant_digest, "grant", joined_at)
     VALUES ($1, 'T0', $2, $3, $4)
     ON CONFLICT (did) DO UPDATE SET vmc_grant_digest = EXCLUDED.vmc_grant_digest, "grant" = EXCLUDED."grant",
                                     vmc_ack_digest = NULL, ack = NULL, effective_tier = NULL, effective_until = NULL`,
    [holder, grantDigest, JSON.stringify(grant), now.toISOString()],
  );
  return { grant, existing: false };
}

export interface AckResult {
  member: { did: string; tier: Tier; validUntil: string | null };
  vacs: VerifiableCredential[];
  explanation: string[];
}

/** `POST /membership/ack`: completes the pair, sets tier ≥ T1 and runs the PEP. */
export async function acknowledgeMembership(ctx: VtaContext, deps: Pick<PodVtaDeps, 'podSigner' | 'resolver'>, body: unknown): Promise<AckResult> {
  const ack = isObject(body) ? body['ack'] : undefined;
  if (!isObject(ack) || !isType(ack, 'MembershipCredential') || !ack['proof']) throw bad('BAD_REQUEST', 'The acknowledgement must be a signed MembershipCredential.');
  const ackVc = ack as unknown as VerifiableCredential & { proof: DataIntegrityProof };
  const grantDigest = ackVc.credentialSubject?.['digestMultibase'];
  const rows = typeof grantDigest === 'string'
    ? await ctx.db.query<MemberRow>('SELECT * FROM members WHERE vmc_grant_digest = $1', [grantDigest])
    : [];
  const member = rows[0];
  if (!member || !member.grant) throw bad('DIGEST_MISMATCH', 'This acknowledgement does not refer to any membership grant from this pod.');
  if (ackVc.issuer !== member.did || ackVc.credentialSubject.id !== ctx.podDid) {
    throw bad('PAIR_INCOMPLETE', 'The acknowledgement must come from the granted member back to this pod.');
  }
  const proof = await verifyDocument(ackVc, deps.resolver, { proofPurpose: 'assertionMethod' });
  if (!proof.ok) throw bad('BAD_PROOF', 'The member\'s signature on the acknowledgement did not check out.', proof.error);
  const grant = json<VerifiableCredential>(member.grant);
  const pair = isMembershipPairComplete(grant, ackVc, ctx.now());
  if (!pair.ok) {
    const code = /does not refer/.test(pair.reason ?? '') ? 'DIGEST_MISMATCH' : 'PAIR_INCOMPLETE';
    throw bad(code, `The membership pair is not complete: ${pair.reason ?? 'unknown reason'}`);
  }
  const ackDigest = digestMultibase(ackVc);
  const governance: Tier = (TIERS as readonly string[]).includes(member.tier) ? (member.tier as Tier) : 'T0';
  const effectiveNow: Tier = (TIERS as readonly string[]).includes(member.effective_tier ?? '') ? (member.effective_tier as Tier) : governance;

  if (member.vmc_ack_digest === ackDigest) {
    // Replay of the same ack: return the current state without re-issuing.
    const [log] = await ctx.db.query<{ credential: unknown }>(
      `SELECT credential FROM vac_issuance_log WHERE subject_did = $1 AND revoked_at IS NULL AND credential IS NOT NULL
        ORDER BY issued_at DESC, id DESC LIMIT 1`,
      [member.did],
    );
    return {
      member: { did: member.did, tier: effectiveNow, validUntil: toIso(member.valid_until) },
      vacs: log ? [json<VerifiableCredential>(log.credential)] : [],
      explanation: ['This membership was already acknowledged.'],
    };
  }

  // Admission writes the governance floor T1 (unless governance already recorded a higher tier) to BOTH
  // `tier` and `effective_tier`; a re-applying former member starts again at max(T1, governance tier).
  const tier: Tier = tierRank(governance) > tierRank('T1') ? governance : 'T1';
  const validUntil = new Date(Math.min(Date.parse(grant.validUntil!), Date.parse(ackVc.validUntil!))).toISOString();
  const now = ctx.now().toISOString();
  await ctx.db.query(
    `UPDATE members SET tier = $2, ack = $3, vmc_ack_digest = $4, valid_until = $5, joined_at = $6 WHERE did = $1`,
    [member.did, tier, JSON.stringify(ackVc), ackDigest, validUntil, now],
  );
  const reason = [
    'Your membership pair is complete.',
    tier === 'T1' ? 'Admission at an attestation event places you at tier T1.' : `You keep tier ${tier}.`,
  ];
  const issued = await issueAuthorities(ctx, deps, member.did, tier, reason);
  await setEffective(ctx, member.did, tier, issued.vacs[0]?.validUntil ?? null);
  return { member: { did: member.did, tier, validUntil }, ...issued };
}

/** Steward view of members. */
export async function listMembers(ctx: VtaContext) {
  const rows = await ctx.db.query<MemberRow>('SELECT * FROM members ORDER BY joined_at DESC, did');
  const now = ctx.now().getTime();
  return rows.map((r) => ({
    did: r.did,
    tier: r.effective_tier ?? r.tier,
    governanceTier: r.tier,
    effectiveUntil: toIso(r.effective_until),
    status: r.grant && !r.ack ? 'pending' : 'member',
    validUntil: toIso(r.valid_until),
    expired: r.valid_until ? toMs(r.valid_until) <= now : false,
    joinedAt: toIso(r.joined_at),
  }));
}
