/**
 * @passport/cc-gateway — the pod's native mutual-credit ledger and payment gateway (ADR-23, B3 §6/§9):
 * accounts on `credit:account`, limits by `credit:limit:Ln`, Merchant Mode (enterprises, acceptance rules,
 * staff via attenuated `pay:receive`, commitments), the two-leg payment (request → authorization → receipt),
 * POS tender recording, and the circulation steward console (exposure, re-spend, kill criteria, exports).
 * Credit is never bought or sold: balances only move by transfers and always sum to zero.
 */
export type { GatewayContext, GatewayRoute, GatewayDeps } from './util.js';
export {
  LIMIT_BANDS,
  ENTERPRISE_LIMIT_FACTOR,
  DEFAULT_CEILING_SHARE,
  highestBand,
  openAccount,
  openMemberAccount,
  getAccount,
  accountView,
  raiseBand,
  rootPodActions,
  verifiedRootActions,
  requireRootAction,
  settle,
  statement,
  type LimitBand,
  type AccountView,
  type SettleInput,
  type SettleResult,
  type StatementEntry,
} from './ledger.js';
export {
  ACCEPTANCE_CATEGORIES,
  MERCHANT_VAC_DAYS,
  STAFF_MAX_DAYS,
  createEnterprise,
  updateRules,
  setEnterpriseLimit,
  addStaff,
  revokeStaff,
  addCommitment,
  listMine,
  getRules,
  enterpriseRkey,
  type Rules,
  type AcceptanceCategory,
} from './merchant.js';
export { REQUEST_TTL_MS, OFFLINE_SYNC_WINDOW_MS, podDomain, createPayRequest, authorizePayment, getReceipt, staffVacDigestOf } from './pay.js';
export {
  RESPEND_BREACH,
  RESPEND_WARN,
  CEILING_HOT,
  UNMET_BREACH_MIN,
  unmetDemandStatus,
  csvCell,
  CSV_HEADER,
  reSpendRatio,
  exposure,
  brokerageQueue,
  listMatches,
  logMatch,
  postFlag,
  getFlags,
  transactionsCsv,
  totals1099b,
  fileTransactionDispute,
  type KillCriterion,
  type KillStatus,
} from './steward.js';
export { smokeTransfer } from './smoke.js';
export { createGatewayRoutes } from './routes.js';
