/**
 * `createRoundRoutes()` — the grants round `Route[]` table (B3 §9, MVP plan §5 Task 13). `apps/web` mounts it
 * under `/api/round`.
 *
 * Auth: round stewards are members holding `pep:review` (the MVP has no separate round-steward scope);
 * proposing needs `round:propose`. Ballots are `member`: a personal ballot needs `round:vote` in the session;
 * a group ballot is authorised by the group-delegation presentation it carries (verified with `verifyDTG`).
 * Handlers re-check authority themselves, so they are safe even when mounted without the `auth` gate.
 * Before publication, the adjustment log inside a tally is shown to stewards only.
 */
import { requireAuthority, requireSession, type RouteRequest } from '@passport/service-kit';
import {
  addAdjustment,
  closeRound,
  createProposal,
  createRound,
  getRound,
  getTally,
  listAdjustments,
  listProposals,
  listRounds,
  openRound,
  publicTally,
  publishRound,
  requirePodSession,
  submitBallot,
  verifyRound,
} from './rounds.js';
import type { RoundContext, RoundDeps, RoundRoute } from './types.js';

export const STEWARD_SCOPE = 'pep:review';

const idOf = (req: RouteRequest): string => req.params['id'] ?? '';

export function createRoundRoutes(deps: RoundDeps): RoundRoute[] {
  const steward = (ctx: RoundContext, req: RouteRequest) => {
    const session = requireAuthority(req, STEWARD_SCOPE);
    requirePodSession(ctx, session);
    return session;
  };
  const isSteward = (ctx: RoundContext, req: RouteRequest) =>
    !!req.session && req.session.pod === ctx.podDid && req.session.authorities.includes(STEWARD_SCOPE);
  return [
    {
      method: 'POST',
      path: '/rounds',
      auth: `authority:${STEWARD_SCOPE}`,
      handler: async (ctx, req) => {
        steward(ctx, req);
        return { status: 201, body: await createRound(ctx, req.body) };
      },
    },
    {
      method: 'GET',
      path: '/rounds',
      auth: 'none',
      handler: async (ctx, req) => ({ body: { rounds: await listRounds(ctx, req.query['status'] || undefined) } }),
    },
    {
      method: 'GET',
      path: '/rounds/:id',
      auth: 'none',
      handler: async (ctx, req) => {
        const { tally, ...round } = await getRound(ctx, idOf(req));
        return { body: { ...round, ...(tally ? { tally: publicTally(tally, round.status, isSteward(ctx, req)) } : {}) } };
      },
    },
    {
      method: 'POST',
      path: '/rounds/:id/open',
      auth: `authority:${STEWARD_SCOPE}`,
      handler: async (ctx, req) => {
        steward(ctx, req);
        return { body: await openRound(ctx, idOf(req)) };
      },
    },
    {
      method: 'POST',
      path: '/rounds/:id/proposals',
      auth: 'authority:round:propose',
      handler: async (ctx, req) => {
        const session = requireAuthority(req, 'round:propose');
        return { status: 201, body: await createProposal(ctx, session, idOf(req), req.body) };
      },
    },
    {
      method: 'GET',
      path: '/rounds/:id/proposals',
      auth: 'none',
      handler: async (ctx, req) => {
        await getRound(ctx, idOf(req));
        return { body: { proposals: await listProposals(ctx, idOf(req)) } };
      },
    },
    {
      method: 'POST',
      path: '/rounds/:id/ballots',
      auth: 'member',
      handler: async (ctx, req) => {
        const session = requireSession(req);
        return { status: 201, body: await submitBallot(ctx, deps, session, idOf(req), req.body) };
      },
    },
    {
      method: 'POST',
      path: '/rounds/:id/close',
      auth: `authority:${STEWARD_SCOPE}`,
      handler: async (ctx, req) => {
        steward(ctx, req);
        return { body: await closeRound(ctx, idOf(req)) };
      },
    },
    {
      method: 'POST',
      path: '/rounds/:id/adjustments',
      auth: `authority:${STEWARD_SCOPE}`,
      handler: async (ctx, req) => {
        const session = steward(ctx, req);
        return { status: 201, body: await addAdjustment(ctx, session, idOf(req), req.body) };
      },
    },
    {
      method: 'GET',
      path: '/rounds/:id/adjustments',
      auth: 'none',
      handler: async (ctx, req) => {
        // Public once published; before that the review log is for stewards.
        const round = await getRound(ctx, idOf(req));
        if (round.status !== 'published') steward(ctx, req);
        return { body: { adjustments: await listAdjustments(ctx, idOf(req)) } };
      },
    },
    {
      method: 'POST',
      path: '/rounds/:id/publish',
      auth: `authority:${STEWARD_SCOPE}`,
      handler: async (ctx, req) => {
        steward(ctx, req);
        return { body: await publishRound(ctx, idOf(req)) };
      },
    },
    {
      method: 'GET',
      path: '/rounds/:id/tally',
      auth: 'none',
      handler: async (ctx, req) => {
        const { round, tally, ballots } = await getTally(ctx, idOf(req));
        return { body: { tally: publicTally(tally, round.status, isSteward(ctx, req)), ballots } };
      },
    },
    {
      method: 'GET',
      path: '/rounds/:id/verify',
      auth: 'none',
      handler: async (ctx: RoundContext, req) => {
        const r = await verifyRound(ctx, deps, idOf(req));
        const status = (await getRound(ctx, idOf(req))).status;
        const show = (t: typeof r.stored) => publicTally(t, status, isSteward(ctx, req));
        return { body: { ...r, recomputed: show(r.recomputed), stored: show(r.stored) } };
      },
    },
  ];
}
