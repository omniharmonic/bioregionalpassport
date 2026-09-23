import { requireAuthority, requireSession, type Route } from '@passport/service-kit';
import { TIERS, type Tier } from '@passport/vocab';
import { commitEdges } from './commit.js';
import { stewardFlags } from './flags.js';
import { loadGraph } from './graph.js';
import { metricsFor, recommend, seedDistances, v1Scorer } from './scorer.js';
import type { IndexContext, MemberAggregate, Scorer, TierRecommendation } from './types.js';

export interface TrustIndexDeps {
  /** Defaults to the v1 scorer. */
  scorer?: Scorer;
}

function emptyAggregate(did: string): MemberAggregate {
  return {
    did,
    vmcPairComplete: false,
    recordedTier: null,
    witnessedEdges: 0,
    distinctEvents: 0,
    distinctConveners: 0,
    endorsements: [],
  };
}

/**
 * The tier recommendation for one DID, computed on demand (consumed by the PEP).
 * A DID the index has never seen gets a T0 recommendation explaining the T1 path.
 */
export async function recommendTier(ctx: IndexContext, did: string, deps: TrustIndexDeps = {}): Promise<TierRecommendation> {
  const { graph } = await loadGraph(ctx);
  const scorer = deps.scorer ?? v1Scorer;
  const found = scorer.compute(graph, ctx.policy).get(did);
  if (found) return found;
  const aggregate = emptyAggregate(did);
  return recommend(aggregate, metricsFor(aggregate, seedDistances(graph.links, ctx.policy.seedSet), ctx.policy), ctx.policy);
}

export interface RecomputeResult {
  total: number;
  counts: Record<Tier, number>;
  computedAt: string;
  recommendations: Map<string, TierRecommendation>;
}

/**
 * Recomputes every member's recommendation (members rows plus anyone who has
 * posted commitments). Pure read: nothing is persisted; the PEP decides what to
 * issue and never downgrades before expiry (FR-TR-2).
 */
export async function recomputeAll(ctx: IndexContext, deps: TrustIndexDeps = {}): Promise<RecomputeResult> {
  const { graph } = await loadGraph(ctx);
  const recommendations = (deps.scorer ?? v1Scorer).compute(graph, ctx.policy);
  const counts = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
  for (const rec of recommendations.values()) counts[rec.tier] += 1;
  return { total: recommendations.size, counts, computedAt: ctx.now().toISOString(), recommendations };
}

export function createTrustIndexHandlers(deps: TrustIndexDeps = {}) {
  return {
    commit: (ctx: IndexContext, poster: string, body: unknown) => commitEdges(ctx, poster, body),
    explanation: (ctx: IndexContext, did: string) => recommendTier(ctx, did, deps),
    flags: (ctx: IndexContext) => stewardFlags(ctx),
    recompute: (ctx: IndexContext) => recomputeAll(ctx, deps),
    routes: createTrustIndexRoutes(deps),
  };
}

/** Route table mounted by `apps/web` under `/api/index`. */
export function createTrustIndexRoutes(deps: TrustIndexDeps = {}): Route<IndexContext>[] {
  return [
    {
      method: 'POST',
      path: '/commit',
      auth: 'member',
      handler: async (ctx, req) => {
        const session = requireSession(req);
        const result = await commitEdges(ctx, session.subject, req.body);
        return { status: result.accepted > 0 ? 201 : 200, body: result };
      },
    },
    {
      method: 'GET',
      path: '/me/explanation',
      auth: 'member',
      handler: async (ctx, req) => {
        const session = requireSession(req);
        return { body: await recommendTier(ctx, session.subject, deps) };
      },
    },
    {
      method: 'GET',
      path: '/steward/flags',
      auth: 'authority:pep:review',
      handler: async (ctx, req) => {
        requireAuthority(req, 'pep:review');
        return { body: { flags: await stewardFlags(ctx) } };
      },
    },
    {
      method: 'POST',
      path: '/recompute',
      // Operator auth (session VAC or break-glass OPERATOR_TOKEN) is enforced by mountService.
      auth: 'operator',
      handler: async (ctx) => {
        const { total, counts, computedAt } = await recomputeAll(ctx, deps);
        return { body: { total, counts, computedAt } };
      },
    },
  ];
}

