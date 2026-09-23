/**
 * @passport/pos-adapter — POS write-back for the dollar leg of a two-leg payment (B2 §4.7, ADR-28).
 * MVP: interface-only adapters plus a manual-tender adapter; Square OAuth is a follow-up.
 */
export { POS_PROVIDERS, manualAdapter, type PosProvider, type PosAdapter, type TenderInput, type TenderResult, type LedgerEntryLike } from './adapter.js';
export {
  sealMessage,
  merchantScope,
  requireMerchant,
  requireSessionIn,
  findEntry,
  parseTender,
  recordTender,
  pendingReconciliation,
  json,
  toIso,
  num,
  type PosContext,
  type MessageSigner,
  type EntryRow,
  type RecordTenderOptions,
} from './tender.js';
export { createPosAdapterRoutes, type PosAdapterDeps } from './routes.js';
