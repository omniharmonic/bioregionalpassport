import type { Db } from '@passport/db';
import { ServiceError, type PodContext, type SessionClaims } from '@passport/service-kit';
import type { BioregionManifest, TrustPolicy } from '@passport/tenant-config';
import { manualAdapter, POS_PROVIDERS, type LedgerEntryLike, type PosAdapter, type PosProvider, type TenderInput } from './adapter.js';

export type PosContext = PodContext<BioregionManifest, TrustPolicy, Db>;

/** Signs as the pod (same shape as the pod-vta / control-plane `PodSigner`). */
export interface MessageSigner {
  did: string;
  kid: string;
  sign<T extends object>(doc: T, opts?: { proofPurpose?: string; challenge?: string; domain?: string; created?: string }): T & { proof: any };
}

/**
 * Signs a protocol message as a DataIntegrityProof and mirrors `proof.proofValue` into `sig` (B3 §6 names the
 * field `sig`). Verify by removing `sig` and checking `proof`. Any previous `proof`/`sig` is discarded first.
 */
export function sealMessage<T extends Record<string, any>>(signer: MessageSigner, doc: T, created?: string): T & { proof: any; sig: string } {
  const { proof: _p, sig: _s, ...unsigned } = doc;
  const signed = signer.sign(unsigned, created ? { created } : undefined);
  return { ...signed, sig: signed.proof.proofValue } as T & { proof: any; sig: string };
}

export function json<T = any>(v: unknown): T {
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

export function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export function requireSessionIn(ctx: PosContext, session: SessionClaims | undefined): SessionClaims {
  if (!session || !session.subject) {
    throw new ServiceError(401, 'UNAUTHENTICATED', 'You need to present your passport before doing this.');
  }
  if (session.pod !== ctx.podDid) {
    throw new ServiceError(403, 'POD_MISMATCH', 'Your session is not a membership session for this pod.');
  }
  return session;
}

export interface MerchantScopeOptions {
  /**
   * Digest of the staff VAC presented with this request. When given, a non-owner counts only through a
   * `merchant_staff` row with exactly this digest; mutating staff routes always pass it.
   */
  staffVacDigest?: string;
}

/**
 * Enterprises this session may act for (an allow-list):
 * - enterprises it owns (`owner_did`), and
 * - enterprises whose `pay:receive@<did>` authority the session carries AND for which the subject has an active
 *   `merchant_staff` row (`revoked_at IS NULL AND valid_until > now`, and matching `staffVacDigest` when given).
 * A valid attenuated VAC the owner never registered grants nothing here. Sessions carry no VAC digests, so read-only
 * routes accept any active row; mutating routes require the staff VAC in the body (digest-matched).
 */
export async function merchantScope(ctx: PosContext, session: SessionClaims, opts: MerchantScopeOptions = {}): Promise<string[]> {
  const scoped = session.authorities.filter((a) => a.startsWith('pay:receive@')).map((a) => a.slice('pay:receive@'.length));
  const owned = await ctx.db.query<{ did: string }>('SELECT did FROM enterprises WHERE owner_did = $1', [session.subject]);
  const staffed = scoped.length
    ? await ctx.db.query<{ enterprise_did: string }>(
        `SELECT DISTINCT enterprise_did FROM merchant_staff
          WHERE staff_did = $1 AND enterprise_did = ANY($2::text[]) AND revoked_at IS NULL AND valid_until > $3::timestamptz
            AND ($4::text IS NULL OR vac_digest = $4::text)`,
        [session.subject, scoped, ctx.now().toISOString(), opts.staffVacDigest ?? null],
      )
    : [];
  return [...new Set([...owned.map((r) => r.did), ...staffed.map((r) => r.enterprise_did)])];
}

export async function isOwner(ctx: PosContext, session: SessionClaims, enterpriseDid: string): Promise<boolean> {
  const rows = await ctx.db.query('SELECT 1 FROM enterprises WHERE did = $1 AND owner_did = $2', [enterpriseDid, session.subject]);
  return rows.length > 0;
}

/**
 * Owner, or active staff. `staffVacDigest` is the digest of the staff VAC sent with a mutating request; for a
 * non-owner it is required when `requireStaffVac` is set.
 */
export async function requireMerchant(
  ctx: PosContext,
  session: SessionClaims,
  enterpriseDid: string,
  opts: MerchantScopeOptions & { requireStaffVac?: boolean } = {},
): Promise<'owner' | 'staff'> {
  if (enterpriseDid && (await isOwner(ctx, session, enterpriseDid))) return 'owner';
  if (opts.requireStaffVac && !opts.staffVacDigest) {
    throw new ServiceError(403, 'NOT_MERCHANT', 'Staff need to present their staff authority credential to do this.');
  }
  const scope = await merchantScope(ctx, session, opts.staffVacDigest ? { staffVacDigest: opts.staffVacDigest } : {});
  if (!enterpriseDid || !scope.includes(enterpriseDid)) {
    throw new ServiceError(403, 'NOT_MERCHANT', 'Only the owner or current staff of this enterprise can do this.');
  }
  return 'staff';
}

export interface EntryRow {
  id: string | number;
  payer_did: string | null;
  payee_did: string | null;
  amount: string | number;
  unit: string | null;
  invoice: string | null;
  request: unknown;
  rung_up_by?: string | null;
  authorization: unknown;
  receipt: unknown;
  external_tender: unknown;
  status: string;
  created_at: unknown;
}

/** Looks a ledger entry up by its transaction id (numeric) or its invoice. */
export async function findEntry(ctx: PosContext, idOrInvoice: string): Promise<EntryRow | undefined> {
  const rows = /^\d+$/.test(idOrInvoice)
    ? await ctx.db.query<EntryRow>('SELECT * FROM ledger_entries WHERE id = $1 OR invoice = $2', [idOrInvoice, idOrInvoice])
    : await ctx.db.query<EntryRow>('SELECT * FROM ledger_entries WHERE invoice = $1', [idOrInvoice]);
  return rows[0];
}

export function parseTender(body: unknown): TenderInput {
  if (!isObject(body)) throw new ServiceError(400, 'BAD_REQUEST', 'A tender needs a provider and the dollar amount.');
  const provider = body['provider'];
  if (typeof provider !== 'string' || !(POS_PROVIDERS as readonly string[]).includes(provider)) {
    throw new ServiceError(400, 'BAD_REQUEST', `The provider must be one of ${POS_PROVIDERS.join(', ')}.`);
  }
  const dollars = body['dollars'];
  if (typeof dollars !== 'number' || !Number.isFinite(dollars) || dollars < 0) {
    throw new ServiceError(400, 'BAD_REQUEST', 'The dollar amount must be zero or more.');
  }
  const ref = body['ref'];
  if (ref !== undefined && typeof ref !== 'string') throw new ServiceError(400, 'BAD_REQUEST', 'The POS reference must be text.');
  return { provider: provider as PosProvider, dollars: Math.round(dollars * 100) / 100, ...(typeof ref === 'string' && ref.trim() ? { ref: ref.trim() } : {}) };
}

export interface RecordTenderOptions {
  adapter?: PosAdapter;
  /** When given, the receipt's `posWriteBack` is updated and the receipt re-signed as the pod. */
  signer?: MessageSigner;
}

/**
 * Records the external (dollar) tender of a settled payment: writes `external_tender` and, with a signer,
 * re-signs the receipt with `posWriteBack.status = 'recorded'`. Caller checks the session is merchant for the payee.
 */
export async function recordTender(ctx: PosContext, entry: EntryRow, tender: TenderInput, opts: RecordTenderOptions = {}) {
  if (entry.status !== 'settled') {
    throw new ServiceError(409, 'NOT_SETTLED', 'This payment has not settled yet, so there is no tender to record.');
  }
  if (entry.external_tender) {
    throw new ServiceError(409, 'ALREADY_RECORDED', 'The dollar tender for this payment has already been recorded.');
  }
  const req = entry.request ? json<Record<string, any>>(entry.request) : null;
  const saleValue = Number(req?.['totalSale']?.value);
  if (Number.isFinite(saleValue)) {
    const due = Math.round((saleValue - num(entry.amount)) * 100) / 100;
    if (Math.abs(tender.dollars - due) > 0.01) {
      throw new ServiceError(400, 'TENDER_MISMATCH', `The dollar tender for this sale should be ${due.toFixed(2)} (total sale less the credits paid).`);
    }
  }
  const adapter = opts.adapter ?? manualAdapter;
  const like: LedgerEntryLike = { id: String(entry.id), invoice: entry.invoice, amount: num(entry.amount), unit: entry.unit, payee: entry.payee_did ?? '' };
  const result = await adapter.recordTender(like, tender);
  const externalTender = {
    provider: tender.provider,
    adapter: adapter.provider,
    ref: result.ref,
    dollars: tender.dollars,
    status: result.status,
    recordedAt: ctx.now().toISOString(),
  };
  let receipt = entry.receipt ? json<Record<string, any>>(entry.receipt) : null;
  if (receipt && opts.signer) {
    receipt = sealMessage(opts.signer, {
      ...receipt,
      posWriteBack: { status: result.status, provider: tender.provider, ref: result.ref },
    });
  }
  await ctx.db.query('UPDATE ledger_entries SET external_tender = $2::jsonb, receipt = $3::jsonb WHERE id = $1', [
    entry.id,
    JSON.stringify(externalTender),
    receipt ? JSON.stringify(receipt) : null,
  ]);
  return { transactionId: String(entry.id), externalTender, receipt };
}

/** Settled entries received by `enterpriseDids` with no external tender recorded yet (the unreconciled queue). */
export async function pendingReconciliation(ctx: PosContext, enterpriseDids: string[]) {
  if (!enterpriseDids.length) return [];
  const rows = await ctx.db.query<EntryRow>(
    `SELECT * FROM ledger_entries
      WHERE status = 'settled' AND external_tender IS NULL AND payee_did = ANY($1::text[])
      ORDER BY created_at ASC, id ASC`,
    [enterpriseDids],
  );
  return rows.map((r) => {
    const req = r.request ? json<Record<string, any>>(r.request) : null;
    return {
      transactionId: String(r.id),
      invoice: r.invoice,
      payee: r.payee_did,
      amount: { unit: r.unit ?? 'credit', value: num(r.amount) },
      totalSale: req?.['totalSale'] ?? null,
      dollarsDue: req?.['totalSale'] ? Math.max(0, Math.round((Number(req['totalSale'].value) - num(r.amount)) * 100) / 100) : null,
      createdAt: toIso(r.created_at),
    };
  });
}
