import { buildAdjudication, MAX_VALIDITY_DAYS, randomNonce, type VerifiableCredential } from '@passport/credential-core';
import { ServiceError } from '@passport/service-kit';
import type { PodVtaDeps, VtaContext } from './types.js';
import { addDays, bad, isObject, json, toIso } from './util.js';

interface DisputeRow {
  id: string;
  subject_digest: string | null;
  filed_by: string | null;
  reason: string | null;
  status: string;
  adjudication: unknown;
  created_at: unknown;
}

const view = (r: DisputeRow) => ({
  id: r.id,
  subjectDigest: r.subject_digest,
  filedBy: r.filed_by,
  reason: r.reason,
  status: r.status,
  adjudication: r.adjudication ? json(r.adjudication) : null,
  createdAt: toIso(r.created_at),
});

export async function fileDispute(ctx: VtaContext, filedBy: string, body: unknown) {
  if (!isObject(body) || typeof body['subjectDigest'] !== 'string' || !body['subjectDigest'] || typeof body['reason'] !== 'string' || !body['reason'].trim()) {
    throw bad('BAD_REQUEST', 'A dispute needs the digest of the credential in question and a reason.');
  }
  const id = `dsp_${randomNonce(12)}`;
  const [row] = await ctx.db.query<DisputeRow>(
    `INSERT INTO disputes (id, subject_digest, filed_by, reason, status, created_at) VALUES ($1, $2, $3, $4, 'open', $5) RETURNING *`,
    [id, body['subjectDigest'], filedBy, body['reason'].trim(), ctx.now().toISOString()],
  );
  return view(row!);
}

export async function listDisputes(ctx: VtaContext) {
  const rows = await ctx.db.query<DisputeRow>(`SELECT * FROM disputes ORDER BY (status = 'open') DESC, created_at DESC`);
  return rows.map(view);
}

/**
 * Adjudication (`bioregion:adjudicated`) issued by the pod on behalf of the steward — same ruling as VWCs:
 * `issuer = ctx.podDid`, `credentialSubject.adjudicatedBy = <steward DID>`. The credential subject is the member
 * who filed the dispute (from the dispute row, never from the request body) and `object.digestMultibase` is the
 * disputed credential's digest.
 */
export async function adjudicateDispute(ctx: VtaContext, deps: Pick<PodVtaDeps, 'podSigner'>, steward: string, id: string, body: unknown) {
  if (!isObject(body) || typeof body['outcome'] !== 'string' || !body['outcome'].trim()) {
    throw bad('BAD_REQUEST', 'An adjudication needs an outcome.');
  }
  const [row] = await ctx.db.query<DisputeRow>('SELECT * FROM disputes WHERE id = $1', [id]);
  if (!row) throw new ServiceError(404, 'NOT_FOUND', 'There is no dispute with that id in this pod.');
  if (row.status !== 'open') throw new ServiceError(409, 'ALREADY_ADJUDICATED', 'This dispute has already been adjudicated.');
  if (!row.filed_by) throw new ServiceError(409, 'NO_SUBJECT', 'This dispute does not record who filed it, so it cannot be adjudicated.');
  const now = ctx.now();
  const unsigned: VerifiableCredential = buildAdjudication({
    steward: ctx.podDid,
    subject: row.filed_by,
    disputedDigest: row.subject_digest ?? '',
    outcome: body['outcome'].trim(),
    validFrom: now.toISOString(),
    validUntil: addDays(now, MAX_VALIDITY_DAYS.adjudication),
  });
  unsigned.credentialSubject['adjudicatedBy'] = steward;
  const adjudication = deps.podSigner.sign(unsigned, { created: now.toISOString() });
  const [updated] = await ctx.db.query<DisputeRow>(
    `UPDATE disputes SET adjudication = $2, status = 'adjudicated' WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(adjudication)],
  );
  return view(updated!);
}
