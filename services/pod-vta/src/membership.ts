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
import { getEventRow } from './events.js';
import { issueAuthorities } from './pep.js';
import type { PodVtaDeps, VtaContext } from './types.js';
import { addDays, bad, isObject, json, toIso, toMs } from './util.js';

const WITNESS_INVALID = 'Admission needs a witness credential from one of this pod\'s attestation events.';

export interface MemberRow {
  did: string;
  tier: string;
  vmc_grant_digest: string | null;
  vmc_ack_digest: string | null;
  grant: unknown;
  ack: unknown;
  valid_until: unknown;
  joined_at: unknown;
}

const isType = (vc: any, t: string) => Array.isArray(vc?.type) && vc.type.includes('VerifiableCredential') && vc.type.includes(t);

function witnessInvalid(detail?: string): ServiceError {
  return new ServiceError(403, 'WITNESS_INVALID', WITNESS_INVALID, detail);
}

/**
 * Checks a VWC for admission (FR-TR-3): signed by this pod (the VTA issues VWCs on behalf of conveners),
 * a `dtg:witnessed` statement whose `taskContext` names one of this pod's attestation events with the same
 * task digest, recorded in `witness_refs`, and unexpired. The witnessing convener must have held `vwc:issue`
 * when it was issued — the witness route enforces that, so a `witness_refs` row is the proof.
 */
export async function checkWitness(ctx: VtaContext, deps: Pick<PodVtaDeps, 'resolver'>, vwc: unknown, holder: string): Promise<{ eventId: string; placeId: string | null; digest: string }> {
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
    throw witnessInvalid('The witness credential names someone else.');
  }
  const eventId = subject['taskContext'];
  const event = typeof eventId === 'string' ? await getEventRow(ctx, eventId) : undefined;
  if (!event || !event.attestation) throw witnessInvalid('The witness credential does not name an attestation event of this pod.');
  if (!event.task_digest || event.task_digest !== subject['taskDigestMultibase']) throw witnessInvalid('The witness credential does not match the event\'s task document.');
  const digest = digestMultibase(cred);
  const ref = await ctx.db.query('SELECT 1 FROM witness_refs WHERE digest = $1 AND event_id = $2', [digest, event.id]);
  if (!ref.length) throw witnessInvalid('This pod has no record of issuing that witness credential.');
  return { eventId: event.id, placeId: event.place_id, digest };
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

  const witness = await checkWitness(ctx, deps, body['vwc'], holder);

  const existing = await getMember(ctx, holder);
  const now = ctx.now();
  if (existing?.grant) {
    const grant = json<VerifiableCredential>(existing.grant);
    if (grant.validUntil && Date.parse(grant.validUntil) > now.getTime()) return { grant, existing: true };
  }

  const days = Math.min(ctx.policy.grantValidityDays, MAX_VALIDITY_DAYS.membership);
  const unsigned = buildMembershipGrant({
    pod: ctx.podDid,
    member: holder,
    bioregion: ctx.slug,
    placeIds: [witness.placeId ?? ctx.manifest.place.bioregionPolygon ?? `bioregion:${ctx.slug}`],
    governance: ctx.manifest.governance.url,
    validFrom: now.toISOString(),
    validUntil: addDays(now, days),
  });
  const grant = deps.podSigner.sign(unsigned, { created: now.toISOString() });
  const grantDigest = digestMultibase(grant);
  // Pending row: tier T0 until the ack completes the pair (a re-applying former member keeps their tier).
  await ctx.db.query(
    `INSERT INTO members (did, tier, vmc_grant_digest, "grant", joined_at)
     VALUES ($1, 'T0', $2, $3, $4)
     ON CONFLICT (did) DO UPDATE SET vmc_grant_digest = EXCLUDED.vmc_grant_digest, "grant" = EXCLUDED."grant",
                                     vmc_ack_digest = NULL, ack = NULL`,
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
  const current: Tier = (TIERS as readonly string[]).includes(member.tier) ? (member.tier as Tier) : 'T0';

  if (member.vmc_ack_digest === ackDigest) {
    // Replay of the same ack: return the current state without re-issuing.
    const [log] = await ctx.db.query<{ credential: unknown }>(
      `SELECT credential FROM vac_issuance_log WHERE subject_did = $1 AND revoked_at IS NULL AND credential IS NOT NULL
        ORDER BY issued_at DESC, id DESC LIMIT 1`,
      [member.did],
    );
    return {
      member: { did: member.did, tier: current, validUntil: toIso(member.valid_until) },
      vacs: log ? [json<VerifiableCredential>(log.credential)] : [],
      explanation: ['This membership was already acknowledged.'],
    };
  }

  const tier: Tier = tierRank(current) > tierRank('T1') ? current : 'T1';
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
  return { member: { did: member.did, tier, validUntil }, ...issued };
}

/** Steward view of members. */
export async function listMembers(ctx: VtaContext) {
  const rows = await ctx.db.query<MemberRow>('SELECT * FROM members ORDER BY joined_at DESC, did');
  const now = ctx.now().getTime();
  return rows.map((r) => ({
    did: r.did,
    tier: r.tier,
    status: r.grant && !r.ack ? 'pending' : 'member',
    validUntil: toIso(r.valid_until),
    expired: r.valid_until ? toMs(r.valid_until) <= now : false,
    joinedAt: toIso(r.joined_at),
  }));
}
