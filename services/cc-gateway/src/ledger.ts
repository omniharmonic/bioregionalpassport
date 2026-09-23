/**
 * The native mutual-credit ledger (ADR-23). Every account starts at 0; a transfer debits the payer and credits
 * the payee by the same amount in one transaction, so balances always sum to zero across the pod. A member's
 * negative limit comes from the highest `credit:limit:Ln` authority they hold × `manifest.currency.limits`.
 * Credit is never bought or sold: there is no route that creates balance except a transfer between accounts.
 */
import { verifyDocument, type DataIntegrityProof, type VerifiableCredential } from '@passport/credential-core';
import { json, num, toIso } from '@passport/pos-adapter';
import { ServiceError } from '@passport/service-kit';
import { bad, cents, fmt, isObject, type GatewayContext, type GatewayDeps } from './util.js';

export const LIMIT_BANDS = ['L1', 'L2', 'L3'] as const;
export type LimitBand = (typeof LIMIT_BANDS)[number];

/**
 * Default acceptance ceiling of an enterprise = owner's band limit × this factor × `DEFAULT_CEILING_SHARE`.
 * The ceiling bounds what an enterprise may *hold*; it is not a credit line. Enterprise accounts open with
 * `credit_limit = 0` (they spend only what they earned); a steward may set an explicit enterprise limit.
 */
export const ENTERPRISE_LIMIT_FACTOR = 3;
export const DEFAULT_CEILING_SHARE = 0.8;

/**
 * Pod-scoped actions `subject` holds through its OWN root VACs among `creds`: AuthorityCredentials with no
 * `authority.parent`, `issuer === ctx.podDid`, `credentialSubject.id === subject`, `authority.scope === ctx.podDid`,
 * inside their validity window. Forwarded (attenuated) VACs never count, so a `credit:limit:L3` or `credit:account`
 * passed on by someone else cannot raise a limit or open an account. Signatures are NOT checked here: callers pass
 * credentials already verified (by `verifyDTG`) or use `verifiedRootActions`.
 */
export function rootPodActions(ctx: GatewayContext, creds: unknown, subject: string): Set<string> {
  const out = new Set<string>();
  const now = ctx.now().getTime();
  for (const vc of Array.isArray(creds) ? creds : []) {
    if (!isObject(vc) || !Array.isArray(vc['type']) || !vc['type'].includes('AuthorityCredential')) continue;
    const cs = vc['credentialSubject'];
    const a = isObject(cs) ? cs['authority'] : undefined;
    if (vc['issuer'] !== ctx.podDid || !isObject(cs) || cs['id'] !== subject || !isObject(a)) continue;
    if (a['parent'] !== undefined || a['scope'] !== ctx.podDid || !Array.isArray(a['actions'])) continue;
    const from = Date.parse(String(vc['validFrom']));
    const until = Date.parse(String(vc['validUntil']));
    if (!(from <= now) || !(until > now)) continue;
    for (const act of a['actions']) if (typeof act === 'string') out.add(act);
  }
  return out;
}

/**
 * For routes without a presentation proof (`/accounts/open`, `/merchant/enterprises`): the body carries the
 * holder's credentials (`{ credentials }` or `{ presentation }`); each candidate root VAC must carry a valid pod
 * signature. The session already authenticates the subject.
 */
export async function verifiedRootActions(ctx: GatewayContext, deps: Pick<GatewayDeps, 'resolver'>, body: unknown, subject: string): Promise<Set<string>> {
  const raw = isObject(body) ? (body['credentials'] ?? (isObject(body['presentation']) ? body['presentation']['verifiableCredential'] : undefined)) : undefined;
  const candidates = (Array.isArray(raw) ? raw : []).filter((vc) => rootPodActions(ctx, [vc], subject).size > 0);
  const verified: VerifiableCredential[] = [];
  for (const vc of candidates) {
    const r = await verifyDocument(vc as { proof: DataIntegrityProof }, deps.resolver, { proofPurpose: 'assertionMethod' });
    if (r.ok && r.controller === ctx.podDid) verified.push(vc as VerifiableCredential);
  }
  return rootPodActions(ctx, verified, subject);
}

export function requireRootAction(actions: Set<string>, action: string): void {
  if (!actions.has(action)) {
    throw new ServiceError(403, 'MISSING_AUTHORITY', `This needs your own "${action}" authority from this pod; a passed-on credential does not count.`);
  }
}

/** Highest `credit:limit:Ln` in a session's (pod-scoped) authorities; L1 when none is carried. */
export function highestBand(authorities: readonly string[]): LimitBand {
  let best: LimitBand = 'L1';
  for (const band of LIMIT_BANDS) if (authorities.includes(`credit:limit:${band}`)) best = band;
  return best;
}

export const bandRank = (b: string | null | undefined): number => LIMIT_BANDS.indexOf((b ?? 'L1') as LimitBand);

export interface AccountRow {
  did: string;
  kind: string;
  limit_band: string | null;
  credit_limit: string | number | null;
  balance: string | number;
  opened_at: unknown;
}

export interface AccountView {
  did: string;
  kind: string;
  band: string | null;
  balance: number;
  limit: number;
  /** balance + limit: how many more credits this account may spend. */
  available: number;
  unit: string;
  openedAt: string | null;
}

export const accountView = (ctx: GatewayContext, r: AccountRow): AccountView => {
  const balance = num(r.balance);
  const limit = num(r.credit_limit);
  return {
    did: r.did,
    kind: r.kind,
    band: r.limit_band,
    balance,
    limit,
    available: cents(balance + limit),
    unit: ctx.manifest.currency.unit,
    openedAt: toIso(r.opened_at),
  };
};

export async function getAccount(ctx: GatewayContext, did: string): Promise<AccountRow | undefined> {
  const rows = await ctx.db.query<AccountRow>('SELECT * FROM accounts WHERE did = $1', [did]);
  return rows[0];
}

/** Idempotent: returns the existing account untouched when one is already open for `did`. */
export async function openAccount(
  ctx: GatewayContext,
  p: { did: string; kind: 'member' | 'enterprise'; band: LimitBand; limit: number },
): Promise<{ account: AccountRow; created: boolean }> {
  const inserted = await ctx.db.query<AccountRow>(
    `INSERT INTO accounts (did, kind, limit_band, credit_limit, balance, opened_at) VALUES ($1, $2, $3, $4, 0, $5)
     ON CONFLICT (did) DO NOTHING RETURNING *`,
    [p.did, p.kind, p.band, cents(p.limit), ctx.now().toISOString()],
  );
  if (inserted[0]) return { account: inserted[0], created: true };
  return { account: (await getAccount(ctx, p.did))!, created: false };
}

/** `POST /accounts/open`: a member account with the limit of the highest band among the member's own root VACs. */
export async function openMemberAccount(ctx: GatewayContext, subject: string, rootActions: Set<string>) {
  requireRootAction(rootActions, 'credit:account');
  const band = highestBand([...rootActions]);
  const { account, created } = await openAccount(ctx, { did: subject, kind: 'member', band, limit: ctx.manifest.currency.limits[band] });
  return { account: accountView(ctx, account), created };
}

/**
 * Raises (never lowers) a member account's band when the member's own root VACs (see `rootPodActions`) in a
 * verified presentation show a higher `credit:limit:Ln`.
 * A lower band later (e.g. an expired VAC) leaves the limit alone; stewards adjust limits by hand.
 */
export async function raiseBand(ctx: GatewayContext, did: string, authorities: readonly string[]): Promise<void> {
  const band = highestBand(authorities);
  await ctx.db.query(
    `UPDATE accounts SET limit_band = $2, credit_limit = $3
      WHERE did = $1 AND kind = 'member' AND COALESCE(credit_limit, 0) < $3`,
    [did, band, ctx.manifest.currency.limits[band]],
  );
}

export interface SettleInput {
  from: string;
  to: string;
  amount: number;
  invoice: string;
  unit?: string;
  /** Settle an existing `'requested'` entry instead of inserting a new one. */
  entryId?: string;
}

export interface SettleResult {
  entryId: string;
  settledAt: string;
  payer: { did: string; balance: number };
  payee: { did: string; balance: number };
}

export function overLimitError(balance: number, amount: number, limit: number): ServiceError {
  const past = cents(-(balance - amount) - limit);
  return new ServiceError(403, 'OVER_LIMIT', `This payment would take you ${fmt(past)} credits past your limit of ${fmt(limit)}.`);
}

/**
 * The double-entry core: lock both accounts, check the payer's limit, debit payer, credit payee and record the
 * entry as `'settled'` — all in one transaction. Throws `NO_ACCOUNT`, `OVER_LIMIT`, `ALREADY_PAID`.
 * Acceptance ceilings are the caller's concern (`/pay/authorize`).
 */
export async function settle(ctx: GatewayContext, t: SettleInput): Promise<SettleResult> {
  const amount = cents(t.amount);
  if (!Number.isFinite(t.amount) || amount <= 0) throw bad('BAD_AMOUNT', 'A transfer must be for more than zero credits.');
  if (t.from === t.to) throw bad('SELF_PAYMENT', 'An account cannot pay itself.');
  const unit = t.unit ?? ctx.manifest.currency.unit;
  const settledAt = ctx.now().toISOString();
  return ctx.db.transaction(async (tx) => {
    const rows = await tx.query<AccountRow>('SELECT * FROM accounts WHERE did = ANY($1::text[]) ORDER BY did FOR UPDATE', [[t.from, t.to]]);
    const payer = rows.find((r) => r.did === t.from);
    const payee = rows.find((r) => r.did === t.to);
    if (!payer) throw new ServiceError(409, 'NO_ACCOUNT', 'You do not have a credit account in this pod yet; open one first.');
    if (!payee) throw new ServiceError(409, 'NO_ACCOUNT', 'The receiving enterprise has no credit account in this pod.');
    const payerBalance = num(payer.balance);
    const limit = num(payer.credit_limit);
    if (cents(payerBalance - amount) < -limit) throw overLimitError(payerBalance, amount, limit);
    const newPayer = cents(payerBalance - amount);
    const newPayee = cents(num(payee.balance) + amount);
    await tx.query('UPDATE accounts SET balance = $2 WHERE did = $1', [t.from, newPayer]);
    await tx.query('UPDATE accounts SET balance = $2 WHERE did = $1', [t.to, newPayee]);
    let entryId: string;
    if (t.entryId) {
      const updated = await tx.query<{ id: string | number }>(
        `UPDATE ledger_entries SET payer_did = $2, status = 'settled', created_at = $3
          WHERE id = $1 AND status = 'requested' AND payee_did = $4 RETURNING id`,
        [t.entryId, t.from, settledAt, t.to],
      );
      if (!updated[0]) throw new ServiceError(409, 'ALREADY_PAID', 'This invoice has already been paid.');
      entryId = String(updated[0].id);
    } else {
      const [row] = await tx.query<{ id: string | number }>(
        `INSERT INTO ledger_entries (payer_did, payee_did, amount, unit, invoice, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'settled', $6) RETURNING id`,
        [t.from, t.to, amount, unit, t.invoice, settledAt],
      );
      entryId = String(row!.id);
    }
    return { entryId, settledAt, payer: { did: t.from, balance: newPayer }, payee: { did: t.to, balance: newPayee } };
  });
}

export interface StatementEntry {
  id: string;
  direction: 'in' | 'out';
  payer: string | null;
  payee: string | null;
  amount: number;
  unit: string | null;
  invoice: string | null;
  totalSale: { unit: string; value: number } | null;
  createdAt: string | null;
  status: string;
  receiptId: string | null;
  tender: string | null;
}

/** `GET /accounts/me/statement`: settled entries where `did` paid or was paid, newest first. */
export async function statement(ctx: GatewayContext, did: string, since?: string) {
  const account = await getAccount(ctx, did);
  if (!account) throw new ServiceError(404, 'NO_ACCOUNT', 'You do not have a credit account in this pod yet; open one first.');
  let sinceIso: string | null = null;
  if (since !== undefined && since !== '') {
    const t = Date.parse(since);
    if (Number.isNaN(t)) throw bad('BAD_REQUEST', 'The "since" date could not be read.');
    sinceIso = new Date(t).toISOString();
  }
  const rows = await ctx.db.query<any>(
    `SELECT * FROM ledger_entries
      WHERE status = 'settled' AND (payer_did = $1 OR payee_did = $1) AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
      ORDER BY created_at DESC, id DESC LIMIT 1000`,
    [did, sinceIso],
  );
  const entries: StatementEntry[] = rows.map((r) => {
    const receipt = r.receipt ? json(r.receipt) : null;
    const request = r.request ? json(r.request) : null;
    const tender = r.external_tender ? json(r.external_tender) : null;
    return {
      id: String(r.id),
      direction: r.payee_did === did ? 'in' : 'out',
      payer: r.payer_did,
      payee: r.payee_did,
      amount: num(r.amount),
      unit: r.unit,
      invoice: r.invoice,
      totalSale: request?.totalSale ?? null,
      createdAt: toIso(r.created_at),
      status: r.status,
      receiptId: receipt ? String(receipt.transactionId) : null,
      tender: tender ? String(tender.status) : null,
    };
  });
  return { account: accountView(ctx, account), entries };
}
