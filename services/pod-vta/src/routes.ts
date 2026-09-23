import type { VerifiablePresentation } from '@passport/credential-core';
import { requireAuthority, ServiceError, type RouteRequest } from '@passport/service-kit';
import { createSession, verifyDTG, type VerifyResult } from '@passport/verifier-sdk';
import { DbChallengeStore, defaultChallengeStore, podDomain, type ChallengeStore } from './challenges.js';
import { adjudicateDispute, fileDispute, listDisputes } from './disputes.js';
import { createEvent, getEvent, listEvents, witnessEdge } from './events.js';
import { acknowledgeMembership, applyMembership, listMembers } from './membership.js';
import { refreshAuthorities, revokeAuthority, setGovernanceTier, statusListCredential, statusListUrl, VAC_STATUS_LIST } from './pep.js';
import { defaultRelayStore, relayAppend, relayList } from './relay.js';
import type { PodVtaDeps, VtaContext, VtaRoute } from './types.js';
import { bad, isObject, json, requireMember, toIso, toMs } from './util.js';
import { TIERS, tierRank, type Tier } from '@passport/vocab';

const FORBIDDEN_CODES = new Set(['MISSING_AUTHORITY', 'POD_MISMATCH', 'BROADENED_ATTENUATION', 'CHAIN_TOO_DEEP']);

function challengeOf(presentation: unknown): unknown {
  return isObject(presentation) && isObject(presentation['proof']) ? presentation['proof']['challenge'] : undefined;
}

export interface SessionResponse {
  token: string;
  subject: string;
  tier: string;
  authorities: string[];
  explanation: string[];
}

/**
 * `POST /session` and `POST /session/visitor`: consumes the presentation's challenge (single use), runs
 * `verifyDTG` bound to that challenge and the pod domain, and returns an HMAC session token (the app sets the
 * cookie). Member sessions require the membership pair with this pod; VAC revocation is checked against this
 * pod's own status list. Visitor sessions are holder-only: no pod claim, tier T0, no authorities.
 */
export async function openSession(ctx: VtaContext, deps: PodVtaDeps, challenges: ChallengeStore, body: unknown, visitor: boolean): Promise<SessionResponse> {
  const presentation = isObject(body) ? body['presentation'] : undefined;
  if (!isObject(presentation)) throw bad('BAD_REQUEST', 'Sign-in needs a presentation.');
  const requireAuthorityList = isObject(body) ? body['requireAuthority'] : undefined;
  if (requireAuthorityList !== undefined && (!Array.isArray(requireAuthorityList) || !requireAuthorityList.every((a) => typeof a === 'string' && a))) {
    throw bad('BAD_REQUEST', 'requireAuthority must be a list of authority names.');
  }
  const binding = await challenges.consume(ctx.slug, challengeOf(presentation), ctx.now());
  let result: VerifyResult;
  try {
    result = await verifyDTG(
      presentation as unknown as VerifiablePresentation,
      {
        acceptedPods: [ctx.podDid],
        requireMembership: !visitor,
        ...(!visitor && requireAuthorityList ? { requireAuthority: requireAuthorityList as string[] } : {}),
        challenge: binding.challenge,
        domain: binding.domain,
        podNames: { [ctx.podDid]: ctx.manifest.identity.name },
      },
      {
        resolver: deps.resolver,
        now: ctx.now,
        statusFetch: async (url) => {
          if (url !== statusListUrl(ctx)) throw new Error(`Unknown status list ${url}`);
          return statusListCredential(ctx, deps, VAC_STATUS_LIST);
        },
      },
    );
  } catch (e) {
    throw bad('BAD_REQUEST', e instanceof Error ? e.message : 'The sign-in request could not be read.');
  }
  if (!result.ok || !result.subject) {
    const code = result.error?.code ?? 'BAD_PROOF';
    throw new ServiceError(FORBIDDEN_CODES.has(code) ? 403 : 401, code, result.error?.message ?? 'This presentation was refused.');
  }
  const now = ctx.now();
  if (visitor) {
    const holderOnly: VerifyResult = { ok: true, subject: result.subject, authorities: [], explanation: result.explanation };
    const token = await createSession(holderOnly, deps.sessionSecret, 3600, now);
    return { token, subject: result.subject, tier: 'T0', authorities: [], explanation: result.explanation };
  }
  // Session tier = the PEP's effective tier while it is current (VAC-derived tier otherwise).
  const [row] = await ctx.db.query<{ effective_tier: string | null; effective_until: unknown }>(
    'SELECT effective_tier, effective_until FROM members WHERE did = $1',
    [result.subject],
  );
  let tier = result.tier ?? 'T0';
  if (row?.effective_tier && (TIERS as readonly string[]).includes(row.effective_tier) && toMs(row.effective_until) > now.getTime()) {
    tier = row.effective_tier;
  }
  const token = await createSession({ ...result, tier }, deps.sessionSecret, 3600, now);
  return { token, subject: result.subject, tier, authorities: result.authorities, explanation: result.explanation };
}

async function latestPolicy(ctx: VtaContext): Promise<unknown | null> {
  const rows = await ctx.db.query<{ policy: unknown }>('SELECT policy FROM policy_versions ORDER BY version DESC LIMIT 1');
  return rows[0] ? json(rows[0].policy) : null;
}

/** Authority gate: the session must belong to this pod (403 `POD_MISMATCH`) and carry `scope`. */
function need(ctx: VtaContext, req: RouteRequest, scope: string) {
  requireMember(ctx, req);
  return requireAuthority(req, scope);
}

/** Route table mounted by `apps/web` under `/api/vta`. */
export function createPodVtaRoutes(deps: PodVtaDeps): VtaRoute[] {
  // Challenges persist in platform.relay_messages when a platform database is configured.
  const challenges = deps.challenges ?? (deps.platformDb ? new DbChallengeStore(deps.platformDb) : defaultChallengeStore);
  const relay = { relay: deps.relay ?? defaultRelayStore, ...(deps.platformDb ? { platformDb: deps.platformDb } : {}) };

  return [
    // ── sign-in ────────────────────────────────────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/challenge',
      auth: 'none',
      handler: async (ctx) => ({ body: await challenges.issue(ctx.slug, podDomain(ctx), ctx.now()) }),
    },
    {
      method: 'POST',
      path: '/session',
      auth: 'none',
      handler: async (ctx, req) => ({ body: await openSession(ctx, deps, challenges, req.body, false) }),
    },
    {
      method: 'POST',
      path: '/session/visitor',
      auth: 'none',
      handler: async (ctx, req) => ({ body: await openSession(ctx, deps, challenges, req.body, true) }),
    },

    // ── governance ─────────────────────────────────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/policy',
      auth: 'none',
      handler: async (ctx) => {
        const policy = await latestPolicy(ctx);
        if (!policy) throw new ServiceError(404, 'NO_POLICY', 'This pod has not published a signed trust policy yet.');
        return { body: policy };
      },
    },
    {
      method: 'GET',
      path: '/governance',
      auth: 'none',
      handler: async (ctx) => ({
        body: {
          governance: ctx.manifest.governance,
          policy: (await latestPolicy(ctx)) ?? ctx.policy,
          disclosure: ctx.manifest.governance.disclosure,
        },
      }),
    },

    // ── events ─────────────────────────────────────────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/events',
      auth: 'authority:event:convene',
      handler: async (ctx, req) => {
        const s = need(ctx, req, 'event:convene');
        return { status: 201, body: await createEvent(ctx, deps, s.subject, req.body) };
      },
    },
    { method: 'GET', path: '/events', auth: 'none', handler: async (ctx) => ({ body: { events: await listEvents(ctx) } }) },
    { method: 'GET', path: '/events/:id', auth: 'none', handler: async (ctx, req) => ({ body: await getEvent(ctx, req.params['id'] ?? '') }) },
    {
      method: 'POST',
      path: '/events/:id/witness',
      auth: 'authority:vwc:issue',
      handler: async (ctx, req) => {
        const s = need(ctx, req, 'vwc:issue');
        return { status: 201, body: await witnessEdge(ctx, deps, s.subject, req.params['id'] ?? '', req.body) };
      },
    },

    // ── membership ─────────────────────────────────────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/membership/apply',
      auth: 'none',
      handler: async (ctx, req) => {
        const presentation = isObject(req.body) ? req.body['presentation'] : undefined;
        const binding = await challenges.consume(ctx.slug, challengeOf(presentation), ctx.now());
        const { grant, existing } = await applyMembership(ctx, deps, req.body, binding);
        return { status: existing ? 200 : 201, body: { grant } };
      },
    },
    {
      method: 'POST',
      path: '/membership/ack',
      auth: 'none',
      handler: async (ctx, req) => {
        const r = await acknowledgeMembership(ctx, deps, req.body);
        return { body: { member: { did: r.member.did, tier: r.member.tier }, vacs: r.vacs, explanation: r.explanation } };
      },
    },

    // ── PEP ────────────────────────────────────────────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/authority/refresh',
      auth: 'member',
      handler: async (ctx, req) => {
        const s = requireMember(ctx, req);
        const r = await refreshAuthorities(ctx, deps, s.subject);
        return { body: { tier: r.tier, issued: r.issued, vacs: r.vacs, explanation: r.explanation, ...(r.next ? { next: r.next } : {}) } };
      },
    },
    {
      method: 'POST',
      path: '/authority/revoke',
      auth: 'authority:pep:review',
      handler: async (ctx, req) => {
        const s = need(ctx, req, 'pep:review');
        const b = req.body;
        if (!isObject(b) || typeof b['digest'] !== 'string' || typeof b['reason'] !== 'string' || !b['reason'].trim()) {
          throw bad('BAD_REQUEST', 'Revocation needs the credential digest and a reason.');
        }
        return { body: await revokeAuthority(ctx, b['digest'], b['reason'].trim(), s.subject) };
      },
    },
    {
      method: 'GET',
      path: '/status/:list',
      auth: 'none',
      handler: async (ctx, req) => ({ body: await statusListCredential(ctx, deps, req.params['list'] ?? '') }),
    },

    // ── disputes ───────────────────────────────────────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/disputes',
      auth: 'member',
      handler: async (ctx, req) => {
        const s = requireMember(ctx, req);
        return { status: 201, body: await fileDispute(ctx, s.subject, req.body) };
      },
    },
    {
      method: 'GET',
      path: '/steward/disputes',
      auth: 'authority:pep:review',
      handler: async (ctx, req) => {
        need(ctx, req, 'pep:review');
        return { body: { disputes: await listDisputes(ctx) } };
      },
    },
    {
      method: 'POST',
      path: '/steward/disputes/:id/adjudicate',
      auth: 'authority:pep:review',
      handler: async (ctx, req) => {
        const s = need(ctx, req, 'pep:review');
        return { body: await adjudicateDispute(ctx, deps, s.subject, req.params['id'] ?? '', req.body) };
      },
    },

    // ── steward views ──────────────────────────────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/steward/members',
      auth: 'authority:pep:review',
      handler: async (ctx, req) => {
        need(ctx, req, 'pep:review');
        return { body: { members: await listMembers(ctx) } };
      },
    },
    {
      // Governance write (the only route that sets members.tier). Stewards may record T0–T3; T4 is operator-only.
      method: 'POST',
      path: '/steward/members/:did/tier',
      auth: 'authority:pep:review',
      handler: async (ctx, req) => {
        const s = need(ctx, req, 'pep:review');
        const b = req.body;
        const tier = isObject(b) ? b['tier'] : undefined;
        if (typeof tier !== 'string' || !(TIERS as readonly string[]).includes(tier) || tierRank(tier as Tier) > tierRank('T3')) {
          throw bad('BAD_REQUEST', 'A steward can record a governance tier from T0 to T3.');
        }
        if (!isObject(b) || typeof b['reason'] !== 'string' || !b['reason'].trim()) throw bad('BAD_REQUEST', 'A governance decision needs a reason.');
        return { body: await setGovernanceTier(ctx, req.params['did'] ?? '', tier as Tier, s.subject, b['reason'].trim()) };
      },
    },
    {
      method: 'GET',
      path: '/steward/vac-log',
      auth: 'authority:pep:review',
      handler: async (ctx, req) => {
        need(ctx, req, 'pep:review');
        const rows = await ctx.db.query<any>('SELECT * FROM vac_issuance_log ORDER BY id DESC LIMIT 500');
        return {
          body: {
            entries: rows.map((r) => ({
              id: String(r.id),
              subject: r.subject_did,
              actions: json(r.actions),
              tier: r.tier,
              policyVersion: r.policy_version,
              explanation: json(r.explanation),
              issuedAt: toIso(r.issued_at),
              validUntil: toIso(r.valid_until),
              revokedAt: toIso(r.revoked_at),
              credential: r.credential ? json(r.credential) : null,
            })),
          },
        };
      },
    },

    // ── relay (ADR-22) ─────────────────────────────────────────────────────────────────────────────
    // auth 'none': channel secrecy comes from the QR-derived channel id.
    {
      method: 'POST',
      path: '/relay/:channel',
      auth: 'none',
      handler: async (ctx, req) => ({ status: 201, body: await relayAppend(ctx, relay, req.params['channel'], req.body) }),
    },
    {
      method: 'GET',
      path: '/relay/:channel',
      auth: 'none',
      handler: async (ctx, req) => ({ body: await relayList(ctx, relay, req.params['channel'], req.query['after']) }),
    },
  ];
}

