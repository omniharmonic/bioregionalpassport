import { createResolver, digestMultibase, verifyDocument, type DidResolver, type VerifiableCredential } from '@passport/credential-core';
import { IndexCommitmentSchema } from '@passport/lexicons';
import { ServiceError } from '@passport/service-kit';
import { isAtLeast, PREDICATES, TIERS, type Tier } from '@passport/vocab';
import { z } from 'zod';
import { isEndorsementScope } from './scorer.js';
import type { IndexContext } from './types.js';

/** Scopes a commitment may carry: the three endorsement scopes plus a plain relationship (VRC). */
export const COMMIT_SCOPES = ['lives-here', 'worked-with', 'knows', 'relationship'] as const;

/** A witness reference may be claimed as witnessed by at most the two parties of the edge. */
export const MAX_WITNESS_CLAIMANTS = 2;

/**
 * `org.bioregion.index.commit` body (B3 §5) with one extension: optional
 * per-commitment `evidence.vec`, a signed StatementCredential `dtg:endorses`
 * issued *to the poster*. Items are strict: unknown fields (e.g. a bare,
 * unverifiable `counterparty`) are rejected.
 */
export const CommitBodySchema = z.object({
  commitments: z
    .array(
      IndexCommitmentSchema.extend({
        commitment: z.string().min(8).max(512),
        scope: z.enum(COMMIT_SCOPES),
        evidence: z.strictObject({ vec: z.record(z.string(), z.unknown()) }).optional(),
      }).strict(),
    )
    .min(1)
    .max(100),
});
export type CommitBody = z.infer<typeof CommitBodySchema>;

export interface CommitDeps {
  /** Resolves VEC issuer DIDs. Defaults to `createResolver()` (did:key inline, did:web over HTTPS). */
  resolver?: DidResolver;
}

export interface CommitItemResult {
  commitment: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  witnessed: boolean;
  weighted: boolean;
  linked: boolean;
  note?: string;
}

export interface CommitResult {
  accepted: number;
  duplicates: number;
  rejected: number;
  items: CommitItemResult[];
}

function asTier(value: unknown): Tier | null {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value) ? (value as Tier) : null;
}

function duplicateEvidence(): ServiceError {
  return new ServiceError(400, 'DUPLICATE_EVIDENCE', 'This endorsement has already been counted.');
}

function badEvidence(message: string, hint?: string): ServiceError {
  return new ServiceError(400, 'BAD_EVIDENCE', message, hint);
}

/**
 * Verifies an endorsement VEC offered as evidence and returns its issuer.
 * Throws 400 `BAD_EVIDENCE` when it is not a valid, current `dtg:endorses`
 * StatementCredential issued to `poster` for `scope`.
 */
async function verifyEndorsementEvidence(
  vecInput: Record<string, unknown>,
  poster: string,
  scope: string,
  now: Date,
  resolver: DidResolver,
): Promise<string> {
  const vec = vecInput as unknown as VerifiableCredential;
  const subject = vec.credentialSubject;
  if (!Array.isArray(vec.type) || !vec.type.includes('StatementCredential') || subject?.['predicate'] !== PREDICATES.endorses) {
    throw badEvidence('This evidence is not an endorsement credential.');
  }
  if (subject.id !== poster) throw badEvidence('This endorsement was not issued to you.');
  if (typeof vec.issuer !== 'string' || vec.issuer === poster) {
    throw badEvidence('An endorsement must come from someone other than you.');
  }
  const vecScope = (subject['object'] as { value?: { scope?: unknown } } | undefined)?.value?.scope;
  if (vecScope !== scope) throw badEvidence('This endorsement is for a different scope than the commitment.');
  if (!vec.proof) throw badEvidence('This endorsement is not signed.');
  const verified = await verifyDocument(vec as VerifiableCredential & { proof: NonNullable<VerifiableCredential['proof']> }, resolver, {
    proofPurpose: 'assertionMethod',
  });
  if (!verified.ok) throw badEvidence("This endorsement's signature could not be verified.", verified.error);
  const t = now.getTime();
  if (vec.validFrom && Date.parse(vec.validFrom) > t) throw badEvidence('This endorsement is not valid yet.');
  if (vec.validUntil && Date.parse(vec.validUntil) <= t) throw badEvidence('This endorsement has expired.');
  return vec.issuer;
}

/**
 * Stores a member's opted-in commitments. `poster` is the session subject.
 *
 * - `witnessed` = a witness reference was given, exists in `witness_refs`, and
 *   at most two posters claim it.
 * - `weighted` (endorsement scopes only) = the item carries `evidence.vec`, a
 *   VEC whose proof verifies, whose subject is the poster, and whose issuer is
 *   a pod member recorded at T2 or above. The PEP can also set it via
 *   `markWeighted`.
 * - Only for such weighted endorsements the index stores one link row
 *   `issuer → poster` in `index_links` (the seed-hop adjacency). This is a
 *   documented MVP privacy deviation: beyond salted commitments, the index holds
 *   two directed DIDs per opted-in weighted endorsement.
 *
 * - Each VEC counts once per poster: its `digestMultibase` is stored as
 *   `evidence_digest` (unique per poster); reusing it on another commitment is
 *   refused with 400 `DUPLICATE_EVIDENCE`.
 *
 * Invalid evidence rejects the whole request (400 `BAD_EVIDENCE`).
 */
export async function commitEdges(
  ctx: IndexContext,
  poster: string,
  body: unknown,
  deps: CommitDeps = {},
): Promise<CommitResult> {
  const parsed = CommitBodySchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ServiceError(
      400,
      'INVALID_COMMIT',
      'The commit body must be a list of 1–100 commitments, each with a commitment hash and a known scope.',
      first ? `${first.path.join('.') || '(root)'}: ${first.message}` : undefined,
    );
  }
  const now = ctx.now();
  const resolver = deps.resolver ?? createResolver();

  // Verify all evidence up front so a bad credential rejects the request before anything is written.
  // Each VEC is bound to one posting per poster (evidence_digest); replays are refused.
  const issuers = new Map<number, string>();
  const digests = new Map<number, string>();
  const seenInRequest = new Set<string>();
  for (const [i, item] of parsed.data.commitments.entries()) {
    if (!item.evidence) continue;
    if (!isEndorsementScope(item.scope)) throw badEvidence('Endorsement evidence can only accompany an endorsement scope.');
    if (item.witnessRef) throw badEvidence('An endorsement commitment cannot also carry a witness reference.');
    issuers.set(i, await verifyEndorsementEvidence(item.evidence.vec, poster, item.scope, now, resolver));
    const digest = digestMultibase(item.evidence.vec);
    if (seenInRequest.has(digest)) throw duplicateEvidence();
    seenInRequest.add(digest);
    const prior = await ctx.db.query<{ commitment: string }>(
      'SELECT commitment FROM index_postings WHERE poster_did = $1 AND evidence_digest = $2',
      [poster, digest],
    );
    // Re-posting the very same (commitment, VEC) is an idempotent retry; any other reuse is a replay.
    if (prior[0] && prior[0].commitment !== item.commitment) throw duplicateEvidence();
    digests.set(i, digest);
  }

  const items: CommitItemResult[] = [];
  for (const [i, item] of parsed.data.commitments.entries()) {
    const result: CommitItemResult = {
      commitment: item.commitment,
      status: 'accepted',
      witnessed: false,
      weighted: false,
      linked: false,
    };
    items.push(result);

    const existing = await ctx.db.query<{ scope: string; revoked_at: unknown }>(
      'SELECT scope, revoked_at FROM edge_commitments WHERE commitment = $1',
      [item.commitment],
    );
    if (existing[0] && existing[0].scope !== item.scope) {
      result.status = 'rejected';
      result.note = 'This commitment is already recorded with a different scope.';
      continue;
    }
    if (existing[0]?.revoked_at) {
      result.status = 'rejected';
      result.note = 'This commitment was revoked and cannot be posted again.';
      continue;
    }

    let witnessFound = false;
    if (item.witnessRef) {
      const w = await ctx.db.query('SELECT digest FROM witness_refs WHERE digest = $1', [item.witnessRef]);
      witnessFound = w.length > 0;
      if (!witnessFound) result.note = 'The witness reference was not found, so this is stored as unwitnessed.';
    }

    let claimsWitness = false;
    if (witnessFound) {
      const claimants = await ctx.db.query<{ poster_did: string }>(
        `SELECT DISTINCT p.poster_did FROM index_postings p
           JOIN edge_commitments c ON c.commitment = p.commitment
          WHERE p.witnessed AND c.witness_ref = $1`,
        [item.witnessRef],
      );
      const already = claimants.some((c) => c.poster_did === poster);
      if (already || claimants.length < MAX_WITNESS_CLAIMANTS) {
        claimsWitness = true;
      } else {
        result.note = 'This witness reference is already claimed by both parties of the edge, so it is stored as unwitnessed.';
      }
    }

    await ctx.db.query(
      `INSERT INTO edge_commitments (commitment, scope, witnessed, witness_ref, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (commitment) DO UPDATE
         SET witnessed = edge_commitments.witnessed OR EXCLUDED.witnessed,
             witness_ref = COALESCE(edge_commitments.witness_ref, EXCLUDED.witness_ref)`,
      [item.commitment, item.scope, witnessFound, item.witnessRef ?? null, now],
    );

    const issuer = issuers.get(i);
    let weighted = false;
    if (issuer) {
      const rows = await ctx.db.query<{ tier: string }>('SELECT tier FROM members WHERE did = $1', [issuer]);
      const tier = asTier(rows[0]?.tier);
      if (!rows[0]) result.note = 'The endorser is not a member of this pod, so this endorsement is not weighted.';
      else if (tier === null || !isAtLeast(tier, 'T2')) result.note = 'The endorser is below T2, so this endorsement is not weighted.';
      weighted = tier !== null && isAtLeast(tier, 'T2');
    }

    const inserted = await ctx.db.query(
      `INSERT INTO index_postings (commitment, poster_did, witnessed, weighted, created_at, evidence_digest, endorser_did)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (commitment, poster_did) DO NOTHING
       RETURNING commitment`,
      [item.commitment, poster, claimsWitness, weighted, now, digests.get(i) ?? null, issuer ?? null],
    );
    if (inserted.length === 0) {
      result.status = 'duplicate';
      const prior = await ctx.db.query<{ witnessed: boolean; weighted: boolean }>(
        'SELECT witnessed, weighted FROM index_postings WHERE commitment = $1 AND poster_did = $2',
        [item.commitment, poster],
      );
      result.witnessed = prior[0]?.witnessed ?? false;
      result.weighted = prior[0]?.weighted ?? false;
    } else {
      result.witnessed = claimsWitness;
      result.weighted = weighted;
    }

    if (issuer && weighted) {
      await ctx.db.query(
        `INSERT INTO index_links (from_did, to_did, created_at) VALUES ($1, $2, $3)
         ON CONFLICT (from_did, to_did) DO NOTHING`,
        [issuer, poster, now],
      );
      result.linked = true;
    }
  }

  return {
    accepted: items.filter((i) => i.status === 'accepted').length,
    duplicates: items.filter((i) => i.status === 'duplicate').length,
    rejected: items.filter((i) => i.status === 'rejected').length,
    items,
  };
}

/**
 * PEP hook: marks a member's endorsement postings as weighted (or not) once the
 * PEP has verified the endorser's VEC carried `vec:issue:weighted`.
 * Returns the number of postings updated. Does not create hop links.
 */
export async function markWeighted(
  ctx: IndexContext,
  poster: string,
  commitments: readonly string[],
  weighted = true,
): Promise<number> {
  let n = 0;
  for (const commitment of commitments) {
    const rows = await ctx.db.query(
      `UPDATE index_postings SET weighted = $3
        WHERE commitment = $1 AND poster_did = $2 AND NOT witnessed
        RETURNING commitment`,
      [commitment, poster, weighted],
    );
    n += rows.length;
  }
  return n;
}
