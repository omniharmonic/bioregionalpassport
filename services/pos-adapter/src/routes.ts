import { ServiceError, type Route } from '@passport/service-kit';
import { manualAdapter } from './adapter.js';
import {
  findEntry,
  merchantScope,
  parseTender,
  pendingReconciliation,
  recordTender,
  requireMerchant,
  requireSessionIn,
  type MessageSigner,
  type PosContext,
} from './tender.js';

export interface PosAdapterDeps {
  /** Re-signs receipts after write-back; without it only `external_tender` is recorded. */
  podSigner?: MessageSigner;
}

/** Route table mounted by `apps/web` under `/api/pos` (B3 §9 POS adapter). */
export function createPosAdapterRoutes(deps: PosAdapterDeps = {}): Route<PosContext>[] {
  return [
    {
      method: 'POST',
      path: '/square/connect',
      auth: 'member',
      handler: async () => {
        throw new ServiceError(501, 'NOT_IMPLEMENTED', 'Square write-back is coming; record tenders manually for now.');
      },
    },
    {
      method: 'POST',
      path: '/tender/record',
      auth: 'member',
      handler: async (ctx, req) => {
        const s = requireSessionIn(ctx, req.session);
        const id = req.body && typeof req.body === 'object' ? req.body['transactionId'] : undefined;
        if (typeof id !== 'string' || !id) throw new ServiceError(400, 'BAD_REQUEST', 'Recording a tender needs the transaction id.');
        const entry = await findEntry(ctx, id);
        if (!entry) throw new ServiceError(404, 'NOT_FOUND', 'There is no payment with that id in this pod.');
        await requireMerchant(ctx, s, entry.payee_did ?? '');
        const tender = parseTender(req.body);
        return { body: await recordTender(ctx, entry, tender, { adapter: manualAdapter, ...(deps.podSigner ? { signer: deps.podSigner } : {}) }) };
      },
    },
    {
      method: 'GET',
      path: '/reconcile/pending',
      auth: 'member',
      handler: async (ctx, req) => {
        const s = requireSessionIn(ctx, req.session);
        return { body: { pending: await pendingReconciliation(ctx, await merchantScope(ctx, s)) } };
      },
    },
  ];
}
