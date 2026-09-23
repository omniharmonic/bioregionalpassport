/**
 * POS adapters (B2 §4.7, ADR-28). For MVP every adapter is interface-only except the manual one: a merchant
 * records the dollar leg of a two-leg sale by hand, against the ledger transaction id. Square/Clover/Shopify
 * write-back are follow-ups; until then their tenders are recorded manually too.
 */

export const POS_PROVIDERS = ['manual', 'square', 'clover', 'shopify'] as const;
export type PosProvider = (typeof POS_PROVIDERS)[number];

/** The dollar leg of a sale, recorded against a settled ledger entry. */
export interface TenderInput {
  provider: PosProvider;
  /** The POS system's own reference (order/payment id), when there is one. */
  ref?: string;
  /** Dollars taken on the merchant's own rails for this sale. */
  dollars: number;
}

/** The subset of a ledger entry an adapter needs. */
export interface LedgerEntryLike {
  id: string;
  invoice: string | null;
  amount: number;
  unit: string | null;
  payee: string;
}

export interface TenderResult {
  ref: string;
  status: 'recorded' | 'failed';
}

export interface PosAdapter {
  provider: PosProvider;
  recordTender(entry: LedgerEntryLike, tender: TenderInput): Promise<TenderResult>;
}

/**
 * The manual adapter: nothing leaves the pod. The tender is recorded as reported by the merchant, keyed by the
 * POS reference when given, else `manual-<transaction id>`.
 */
export const manualAdapter: PosAdapter = {
  provider: 'manual',
  async recordTender(entry, tender) {
    const ref = typeof tender.ref === 'string' && tender.ref.trim() ? tender.ref.trim() : `manual-${entry.id}`;
    return { ref, status: 'recorded' };
  },
};
