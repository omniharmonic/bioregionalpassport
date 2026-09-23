import { IndexCommitmentSchema } from '@passport/lexicons';
import { ServiceError } from '@passport/service-kit';
import { isAtLeast, TIERS, type Tier } from '@passport/vocab';
import { z } from 'zod';
import { ensureIndexTables } from './schema.js';
import { isEndorsementScope } from './scorer.js';
import type { IndexContext } from './types.js';

/** Scopes a commitment may carry: the three endorsement scopes plus a plain relationship (VRC). */
export const COMMIT_SCOPES = ['lives-here', 'worked-with', 'knows', 'relationship'] as const;

/** A witness reference may be claimed as witnessed by at most the two parties of the edge. */
export const MAX_WITNESS_CLAIMANTS = 2;

/**
 * `org.bioregion.index.commit` body (B3 §5) with one extension: an optional
 * per-commitment `counterparty` DID. When present the index records a directed
 * link `poster → counterparty` in `index_links`, which is the only input to
 * seed-hop distance. Posting it is an explicit opt-in to reveal that link.
 */
export const CommitBodySchema = z.object({
  commitments: z
    .array(
      IndexCommitmentSchema.extend({
        commitment: z.string().min(8).max(512),
        scope: z.enum(COMMIT_SCOPES),
        counterparty: z.string().regex(/^did:[a-z0-9]+:.+/, 'counterparty must be a DID').optional(),
      }),
    )
    .min(1)
    .max(100),
});
export type CommitBody = z.infer<typeof CommitBodySchema>;

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

/**
 * Stores a member's opted-in commitments. `poster` is the session subject.
 * `witnessed` = a witness reference was given, exists in `witness_refs`, and at
 * most two posters claim it. `weighted` (endorsement scopes only) = the named
 * counterparty is a member recorded at T2 or above; the PEP can also set it via
 * `markWeighted` after checking the endorser's `vec:issue:weighted` authority.
 */
export async function commitEdges(ctx: IndexContext, poster: string, body: unknown): Promise<CommitResult> {
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
  await ensureIndexTables(ctx.db);
  const now = ctx.now();
  const items: CommitItemResult[] = [];

  for (const item of parsed.data.commitments) {
    const result: CommitItemResult = {
      commitment: item.commitment,
      status: 'accepted',
      witnessed: false,
      weighted: false,
      linked: false,
    };
    items.push(result);

    if (item.counterparty === poster) {
      result.status = 'rejected';
      result.note = 'A commitment cannot name yourself as the counterparty.';
      continue;
    }

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

    let weighted = false;
    if (isEndorsementScope(item.scope) && !claimsWitness && item.counterparty) {
      const rows = await ctx.db.query<{ tier: string }>('SELECT tier FROM members WHERE did = $1', [item.counterparty]);
      const tier = asTier(rows[0]?.tier);
      weighted = tier !== null && isAtLeast(tier, 'T2');
    }

    const inserted = await ctx.db.query(
      `INSERT INTO index_postings (commitment, poster_did, witnessed, weighted, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (commitment, poster_did) DO NOTHING
       RETURNING commitment`,
      [item.commitment, poster, claimsWitness, weighted, now],
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

    if (item.counterparty) {
      await ctx.db.query(
        `INSERT INTO index_links (from_did, to_did, created_at) VALUES ($1, $2, $3)
         ON CONFLICT (from_did, to_did) DO NOTHING`,
        [poster, item.counterparty, now],
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
 * Returns the number of postings updated.
 */
export async function markWeighted(
  ctx: IndexContext,
  poster: string,
  commitments: readonly string[],
  weighted = true,
): Promise<number> {
  await ensureIndexTables(ctx.db);
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
