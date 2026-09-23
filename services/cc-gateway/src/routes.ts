import { manualAdapter, merchantScope, parseTender, pendingReconciliation, recordTender, requireMerchant } from '@passport/pos-adapter';
import { ServiceError } from '@passport/service-kit';
import { getAccount, accountView, openMemberAccount, statement, verifiedRootActions } from './ledger.js';
import { addCommitment, addStaff, createEnterprise, listMine, revokeStaff, setEnterpriseLimit, updateRules } from './merchant.js';
import { authorizePayment, createPayRequest, getReceipt, loadEntry, staffVacDigestOf } from './pay.js';
import {
  brokerageQueue,
  exposure,
  fileTransactionDispute,
  getFlags,
  listMatches,
  logMatch,
  postFlag,
  totals1099b,
  transactionsCsv,
} from './steward.js';
import { requireAuthorityIn, requireMember, type GatewayDeps, type GatewayRoute } from './util.js';

const STEWARD = 'authority:pep:review' as const;

/** Route table mounted by `apps/web` under `/api/gateway` (B3 §9 ledger gateway). */
export function createGatewayRoutes(deps: GatewayDeps): GatewayRoute[] {
  const adapter = deps.adapter ?? manualAdapter;

  return [
    // ── accounts ───────────────────────────────────────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/accounts/open',
      auth: 'authority:credit:account',
      handler: async (ctx, req) => {
        const s = requireAuthorityIn(ctx, req, 'credit:account');
        // `credit:account` and the band come from the member's own root VACs sent in the body, not the session.
        const roots = await verifiedRootActions(ctx, deps, req.body, s.subject);
        const { account, created } = await openMemberAccount(ctx, s.subject, roots);
        return { status: created ? 201 : 200, body: { account } };
      },
    },
    {
      method: 'GET',
      path: '/accounts/me',
      auth: 'member',
      handler: async (ctx, req) => {
        const s = requireMember(ctx, req);
        const acct = await getAccount(ctx, s.subject);
        if (!acct) throw new ServiceError(404, 'NO_ACCOUNT', 'You do not have a credit account in this pod yet; open one first.');
        return { body: { account: accountView(ctx, acct) } };
      },
    },
    {
      method: 'GET',
      path: '/accounts/me/statement',
      auth: 'member',
      handler: async (ctx, req) => {
        const s = requireMember(ctx, req);
        return { body: await statement(ctx, s.subject, req.query['since']) };
      },
    },

    // ── merchant ───────────────────────────────────────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/merchant/enterprises',
      auth: 'authority:credit:account',
      handler: async (ctx, req) => {
        const s = requireAuthorityIn(ctx, req, 'credit:account');
        return { status: 201, body: await createEnterprise(ctx, deps, s, req.body) };
      },
    },
    {
      method: 'GET',
      path: '/merchant/enterprises/mine',
      auth: 'member',
      handler: async (ctx, req) => ({ body: await listMine(ctx, requireMember(ctx, req)) }),
    },
    {
      method: 'PUT',
      path: '/merchant/enterprises/:did/rules',
      auth: 'member',
      handler: async (ctx, req) => ({ body: await updateRules(ctx, requireMember(ctx, req), req.params['did'] ?? '', req.body) }),
    },
    {
      method: 'POST',
      path: '/merchant/enterprises/:did/staff',
      auth: 'member',
      handler: async (ctx, req) => ({ status: 201, body: await addStaff(ctx, deps, requireMember(ctx, req), req.params['did'] ?? '', req.body) }),
    },
    {
      method: 'DELETE',
      path: '/merchant/enterprises/:did/staff/:staffDid',
      auth: 'member',
      handler: async (ctx, req) => ({
        body: await revokeStaff(ctx, requireMember(ctx, req), req.params['did'] ?? '', req.params['staffDid'] ?? ''),
      }),
    },
    {
      method: 'POST',
      path: '/merchant/commitment',
      auth: 'member',
      handler: async (ctx, req) => ({ status: 201, body: await addCommitment(ctx, requireMember(ctx, req), req.body) }),
    },

    // ── payment ────────────────────────────────────────────────────────────────────────────────────
    // The mount layer's `authority:` check is string-equal, so `pay:receive@<enterpriseDid>` is checked inside.
    {
      method: 'POST',
      path: '/pay/request',
      auth: 'member',
      handler: async (ctx, req) => ({ status: 201, body: await createPayRequest(ctx, deps, requireMember(ctx, req), req.body) }),
    },
    {
      method: 'POST',
      path: '/pay/authorize',
      auth: 'member',
      handler: async (ctx, req) => ({ body: await authorizePayment(ctx, deps, requireMember(ctx, req), req.body) }),
    },
    {
      method: 'GET',
      path: '/pay/:id/receipt',
      auth: 'member',
      handler: async (ctx, req) => ({ body: await getReceipt(ctx, requireMember(ctx, req), req.params['id'] ?? '') }),
    },
    {
      method: 'POST',
      path: '/pay/:id/tender',
      auth: 'member',
      handler: async (ctx, req) => {
        const s = requireMember(ctx, req);
        const entry = await loadEntry(ctx, req.params['id'] ?? '');
        const digest = staffVacDigestOf(req.body);
        await requireMerchant(ctx, s, entry.payee_did ?? '', { requireStaffVac: true, ...(digest ? { staffVacDigest: digest } : {}) });
        const tender = parseTender(req.body);
        return { body: await recordTender(ctx, entry, tender, { adapter, signer: deps.podSigner }) };
      },
    },
    {
      method: 'GET',
      path: '/reconcile/pending',
      auth: 'member',
      handler: async (ctx, req) => {
        const s = requireMember(ctx, req);
        return { body: { pending: await pendingReconciliation(ctx, await merchantScope(ctx, s)) } };
      },
    },

    // ── disputes ───────────────────────────────────────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/disputes',
      auth: 'member',
      handler: async (ctx, req) => ({ status: 201, body: await fileTransactionDispute(ctx, requireMember(ctx, req), req.body) }),
    },

    // ── steward ────────────────────────────────────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/steward/exposure',
      auth: STEWARD,
      handler: async (ctx, req) => {
        requireAuthorityIn(ctx, req, 'pep:review');
        return { body: await exposure(ctx) };
      },
    },
    {
      method: 'PUT',
      path: '/steward/enterprises/:did/limit',
      auth: STEWARD,
      handler: async (ctx, req) => ({ body: await setEnterpriseLimit(ctx, requireAuthorityIn(ctx, req, 'pep:review'), req.params['did'] ?? '', req.body) }),
    },
    {
      method: 'GET',
      path: '/steward/brokerage',
      auth: STEWARD,
      handler: async (ctx, req) => {
        requireAuthorityIn(ctx, req, 'pep:review');
        return { body: await brokerageQueue(ctx) };
      },
    },
    {
      method: 'GET',
      path: '/steward/matches',
      auth: STEWARD,
      handler: async (ctx, req) => {
        requireAuthorityIn(ctx, req, 'pep:review');
        return { body: { matches: await listMatches(ctx) } };
      },
    },
    {
      method: 'POST',
      path: '/steward/matches',
      auth: STEWARD,
      handler: async (ctx, req) => ({ status: 201, body: await logMatch(ctx, requireAuthorityIn(ctx, req, 'pep:review'), req.body) }),
    },
    {
      method: 'GET',
      path: '/steward/flags',
      auth: STEWARD,
      handler: async (ctx, req) => {
        requireAuthorityIn(ctx, req, 'pep:review');
        return { body: { flags: await getFlags(ctx) } };
      },
    },
    {
      method: 'POST',
      path: '/steward/flags',
      auth: STEWARD,
      handler: async (ctx, req) => ({ body: await postFlag(ctx, requireAuthorityIn(ctx, req, 'pep:review'), req.body) }),
    },
    {
      method: 'GET',
      path: '/exports/transactions.csv',
      auth: STEWARD,
      handler: async (ctx, req) => {
        requireAuthorityIn(ctx, req, 'pep:review');
        return {
          body: await transactionsCsv(ctx),
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="${ctx.slug}-transactions.csv"`,
          },
        };
      },
    },
    {
      method: 'GET',
      path: '/exports/1099b.json',
      auth: STEWARD,
      handler: async (ctx, req) => {
        requireAuthorityIn(ctx, req, 'pep:review');
        return { body: await totals1099b(ctx, req.query['year']) };
      },
    },
  ];
}
