/**
 * Circulation steward console back end (FR-CI-5, FR-CI-7, FR-CI-8): exposure / ceiling heat-map, re-spend ratio,
 * the four kill criteria (PRD §9), brokerage queue and matches log, exports (CSV, 1099-B totals), disputes.
 */
import { randomNonce } from '@passport/credential-core';
import { json, merchantScope, num, toIso } from '@passport/pos-adapter';
import { ServiceError, type SessionClaims } from '@passport/service-kit';
import { bad, DAY_MS, isObject, optString, type GatewayContext } from './util.js';

export type KillStatus = 'ok' | 'warn' | 'breach';
export interface KillCriterion {
  id: 'respend' | 'ceilings' | 'unmet-demand' | 'counsel';
  status: KillStatus;
  detail: string;
}

export const RESPEND_WINDOW_DAYS = 60;
export const VOLUME_WINDOW_DAYS = 30;
export const RESPEND_BREACH = 0.35;
export const RESPEND_WARN = 0.6;
export const CEILING_HOT = 0.8;
export const UNMET_BREACH_MIN = 5;

/**
 * "Unmet demand outpacing matches" (PRD §9): unmatched needs (the brokerage queue) vs logged matches. Warn when
 * unmatched > matches; breach when unmatched > 2 × matches and there are at least `UNMET_BREACH_MIN` unmatched
 * needs (so a young pod with two stray needs is not "killed").
 */
export function unmetDemandStatus(unmatched: number, matches: number): KillStatus {
  if (unmatched >= UNMET_BREACH_MIN && unmatched > 2 * matches) return 'breach';
  return unmatched > matches ? 'warn' : 'ok';
}

const clip01 = (n: number) => Math.min(1, Math.max(0, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Share of credits earned by enterprises in the window that were spent again:
 * Σ enterprise outflows / Σ enterprise inflows over settled entries, clipped to 0..1; `null` when enterprises
 * earned nothing in the window. Transfers between two enterprises count on both sides.
 */
export async function reSpendRatio(ctx: GatewayContext, windowDays = RESPEND_WINDOW_DAYS): Promise<{ ratio: number | null; inflow: number; outflow: number }> {
  const since = new Date(ctx.now().getTime() - windowDays * DAY_MS).toISOString();
  const [row] = await ctx.db.query<{ inflow: unknown; outflow: unknown }>(
    `SELECT
       COALESCE(SUM(CASE WHEN pe.kind = 'enterprise' THEN l.amount END), 0) AS inflow,
       COALESCE(SUM(CASE WHEN pr.kind = 'enterprise' THEN l.amount END), 0) AS outflow
     FROM ledger_entries l
     LEFT JOIN accounts pe ON pe.did = l.payee_did
     LEFT JOIN accounts pr ON pr.did = l.payer_did
     WHERE l.status = 'settled' AND l.created_at >= $1`,
    [since],
  );
  const inflow = num(row?.inflow);
  const outflow = num(row?.outflow);
  return { ratio: inflow > 0 ? round3(clip01(outflow / inflow)) : null, inflow, outflow };
}

const words = (s: unknown): Set<string> =>
  new Set(
    String(s ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );

/** `GET /steward/brokerage`: open needs with no offer sharing a resourceSpec keyword and no logged match. */
export async function brokerageQueue(ctx: GatewayContext) {
  const rows = await ctx.db.query<{ id: string; kind: string; enterprise_did: string | null; record: unknown }>('SELECT * FROM offers ORDER BY id');
  const offers = rows.filter((r) => r.kind === 'offer').map((r) => words(json<any>(r.record)?.resourceSpec));
  const matched = new Set(
    (await ctx.db.query<{ key: string }>(`SELECT key FROM steward_flags WHERE key LIKE 'match:%'`)).map((r) => r.key.slice('match:'.length)),
  );
  const needs = rows.filter((r) => r.kind === 'need');
  const queue = needs
    .filter((n) => !matched.has(n.id))
    .filter((n) => {
      const w = words(json<any>(n.record)?.resourceSpec);
      return !offers.some((o) => [...w].some((x) => o.has(x)));
    })
    .map((n) => {
      const rec = json<any>(n.record) ?? {};
      return { needId: n.id, resourceSpec: rec.resourceSpec ?? null, quantity: rec.quantity ?? null, enterprise: n.enterprise_did, record: rec };
    });
  return { queue, needs: needs.length, offers: offers.length };
}

export async function listMatches(ctx: GatewayContext) {
  const rows = await ctx.db.query<{ key: string; value: unknown; updated_at: unknown }>(
    `SELECT * FROM steward_flags WHERE key LIKE 'match:%' ORDER BY updated_at DESC`,
  );
  return rows.map((r) => ({ ...(json<Record<string, unknown>>(r.value) ?? {}), updatedAt: toIso(r.updated_at) }));
}

export async function logMatch(ctx: GatewayContext, s: SessionClaims, body: unknown) {
  const needId = isObject(body) ? optString(body['needId']) : undefined;
  const offerId = isObject(body) ? optString(body['offerId']) : undefined;
  if (!needId || !offerId) throw bad('BAD_REQUEST', 'A match needs the need and the offer it was matched with.');
  const found = await ctx.db.query<{ id: string; kind: string }>('SELECT id, kind FROM offers WHERE id = ANY($1::text[])', [[needId, offerId]]);
  if (!found.some((r) => r.id === needId && r.kind === 'need')) throw new ServiceError(404, 'NOT_FOUND', 'There is no such need in this pod.');
  if (!found.some((r) => r.id === offerId && r.kind === 'offer')) throw new ServiceError(404, 'NOT_FOUND', 'There is no such offer in this pod.');
  const value = { needId, offerId, note: isObject(body) ? (optString(body['note']) ?? null) : null, by: s.subject, at: ctx.now().toISOString() };
  await setFlag(ctx, `match:${needId}`, value);
  return { match: value };
}

export async function setFlag(ctx: GatewayContext, key: string, value: unknown) {
  await ctx.db.query(
    `INSERT INTO steward_flags (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value ?? null), ctx.now().toISOString()],
  );
}

/** `POST /steward/flags` `{ key, value }` (e.g. `{ key: 'counsel', value: { flagged: true, note } }`). */
export async function postFlag(ctx: GatewayContext, s: SessionClaims, body: unknown) {
  const key = isObject(body) ? optString(body['key']) : undefined;
  if (!key || key.length > 100) throw bad('BAD_REQUEST', 'A steward flag needs a short key.');
  if (key.startsWith('match:')) throw bad('BAD_REQUEST', 'Log matches through the matches log, not as a flag.');
  const value = isObject(body) ? body['value'] : undefined;
  const stored = isObject(value) ? { ...value, by: s.subject } : { value: value ?? null, by: s.subject };
  await setFlag(ctx, key, stored);
  return { key, value: stored };
}

export async function getFlags(ctx: GatewayContext) {
  const rows = await ctx.db.query<{ key: string; value: unknown; updated_at: unknown }>(`SELECT * FROM steward_flags WHERE key NOT LIKE 'match:%' ORDER BY key`);
  return rows.map((r) => ({ key: r.key, value: json(r.value), updatedAt: toIso(r.updated_at) }));
}

/** `GET /steward/exposure` */
export async function exposure(ctx: GatewayContext) {
  const rows = await ctx.db.query<{ did: string; name: string; balance: unknown; ceiling: unknown }>(
    `SELECT e.did, e.name, COALESCE(a.balance, 0) AS balance, COALESCE(r.ceiling, 0) AS ceiling
       FROM enterprises e
       LEFT JOIN accounts a ON a.did = e.did
       LEFT JOIN acceptance_rules r ON r.enterprise_did = e.did
      ORDER BY e.name`,
  );
  const enterprises = rows.map((r) => {
    const balance = num(r.balance);
    const ceiling = num(r.ceiling);
    return { did: r.did, name: r.name, balance, ceiling, pct: ceiling > 0 ? round3(balance / ceiling) : 0 };
  });
  const respend = await reSpendRatio(ctx);
  const since = new Date(ctx.now().getTime() - VOLUME_WINDOW_DAYS * DAY_MS).toISOString();
  const [vol] = await ctx.db.query<{ count: unknown; sum: unknown }>(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS sum FROM ledger_entries WHERE status = 'settled' AND created_at >= $1`,
    [since],
  );
  const volume = { count: num(vol?.count), sum: num(vol?.sum) };

  const killCriteria: KillCriterion[] = [];
  // re-spend
  if (respend.ratio === null) {
    killCriteria.push({ id: 'respend', status: 'ok', detail: `Enterprises have earned no credits in the last ${RESPEND_WINDOW_DAYS} days, so there is no re-spend ratio yet.` });
  } else {
    const pct = Math.round(respend.ratio * 100);
    const status: KillStatus = respend.ratio < RESPEND_BREACH ? 'breach' : respend.ratio < RESPEND_WARN ? 'warn' : 'ok';
    killCriteria.push({
      id: 'respend',
      status,
      detail: `Enterprises spent again ${pct}% of the credits they earned in the last ${RESPEND_WINDOW_DAYS} days (kill line ${RESPEND_BREACH * 100}%, target ${RESPEND_WARN * 100}%).`,
    });
  }
  // ceilings
  const hot = enterprises.filter((e) => e.ceiling > 0 && e.pct > CEILING_HOT).length;
  const n = enterprises.length;
  killCriteria.push({
    id: 'ceilings',
    status: n > 0 && hot > n / 3 ? 'breach' : hot > 0 ? 'warn' : 'ok',
    detail: `${hot} of ${n} enterprises are above ${CEILING_HOT * 100}% of their acceptance ceiling (kill line: more than a third).`,
  });
  // unmet demand
  const broker = await brokerageQueue(ctx);
  const matches = (await listMatches(ctx)).length;
  const unmatched = broker.queue.length;
  killCriteria.push({
    id: 'unmet-demand',
    status: unmetDemandStatus(unmatched, matches),
    detail: `${unmatched} needs have no matching offer against ${matches} logged matches (${broker.needs} needs, ${broker.offers} offers in all).`,
  });
  // counsel
  const [counsel] = await ctx.db.query<{ value: unknown }>(`SELECT value FROM steward_flags WHERE key = 'counsel'`);
  const cv = counsel ? json<Record<string, any>>(counsel.value) : null;
  const flagged = !!cv && (cv['flagged'] === true || cv['value'] === true);
  killCriteria.push({
    id: 'counsel',
    status: flagged ? 'breach' : 'ok',
    detail: flagged
      ? `Counsel has flagged a money-transmitter concern${typeof cv?.['note'] === 'string' ? `: ${cv['note']}` : ''}.`
      : 'Counsel has not flagged a money-transmitter concern.',
  });

  return { enterprises, reSpendRatio: respend.ratio, reSpend: respend, volume, killCriteria };
}

/** CSV cell: formula-injection guard (a leading `= + - @` gets a `'` prefix), then RFC 4180 quoting. */
export const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const CSV_HEADER = ['id', 'createdAt', 'payer', 'payee', 'amount', 'unit', 'invoice', 'totalSale', 'tenderStatus'];

/** `GET /exports/transactions.csv`: one line per settled entry, oldest first. */
export async function transactionsCsv(ctx: GatewayContext): Promise<string> {
  const rows = await ctx.db.query<any>(`SELECT * FROM ledger_entries WHERE status = 'settled' ORDER BY created_at ASC, id ASC`);
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    const req = r.request ? json<any>(r.request) : null;
    const tender = r.external_tender ? json<any>(r.external_tender) : null;
    const receipt = r.receipt ? json<any>(r.receipt) : null;
    lines.push(
      [
        String(r.id),
        toIso(r.created_at),
        r.payer_did,
        r.payee_did,
        num(r.amount),
        r.unit,
        r.invoice,
        req?.totalSale ? `${req.totalSale.value} ${req.totalSale.unit}` : '',
        tender?.status ?? receipt?.posWriteBack?.status ?? 'n/a',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** `GET /exports/1099b.json?year=`: per-enterprise credits received in a calendar year (UTC). */
export async function totals1099b(ctx: GatewayContext, yearIn?: string) {
  const year = yearIn ? Number(yearIn) : ctx.now().getUTCFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 3000) throw bad('BAD_REQUEST', 'The year must be a four-digit year.');
  const rows = await ctx.db.query<{ did: string; name: string; total: unknown; count: unknown }>(
    `SELECT e.did, e.name, COALESCE(SUM(l.amount), 0) AS total, COUNT(l.id) AS count
       FROM enterprises e
       LEFT JOIN ledger_entries l ON l.payee_did = e.did AND l.status = 'settled'
            AND l.created_at >= $1::timestamptz AND l.created_at < $2::timestamptz
      GROUP BY e.did, e.name ORDER BY e.name`,
    [`${year}-01-01T00:00:00Z`, `${year + 1}-01-01T00:00:00Z`],
  );
  return {
    year,
    unit: ctx.manifest.currency.unit,
    enterprises: rows.map((r) => ({ did: r.did, name: r.name, totalReceived: num(r.total), count: num(r.count) })),
  };
}

/** `POST /disputes` (member) `{ transactionId, reason }`. The VTA's steward adjudication handles the rest. */
export async function fileTransactionDispute(ctx: GatewayContext, s: SessionClaims, body: unknown) {
  const txId = isObject(body) ? body['transactionId'] : undefined;
  const reason = isObject(body) ? optString(body['reason']) : undefined;
  if ((typeof txId !== 'string' && typeof txId !== 'number') || !reason) throw bad('BAD_REQUEST', 'A dispute needs the transaction id and a reason.');
  const id = String(txId);
  const rows = /^\d+$/.test(id)
    ? await ctx.db.query<{ payer_did: string | null; payee_did: string | null }>('SELECT payer_did, payee_did FROM ledger_entries WHERE id = $1', [id])
    : [];
  if (!rows.length) throw new ServiceError(404, 'NOT_FOUND', 'There is no payment with that id in this pod.');
  const { payer_did, payee_did } = rows[0]!;
  const scope = await merchantScope(ctx, s);
  const party = payer_did === s.subject || (!!payer_did && scope.includes(payer_did)) || (!!payee_did && scope.includes(payee_did));
  if (!party) throw new ServiceError(403, 'NOT_A_PARTY', 'Only the payer or the receiving enterprise can dispute this payment.');
  const disputeId = `dsp_${randomNonce(12)}`;
  const [row] = await ctx.db.query<any>(
    `INSERT INTO disputes (id, subject_digest, filed_by, reason, status, created_at) VALUES ($1, $2, $3, $4, 'open', $5) RETURNING *`,
    [disputeId, id, s.subject, reason, ctx.now().toISOString()],
  );
  return { id: row.id, transactionId: id, filedBy: s.subject, reason, status: row.status, createdAt: toIso(row.created_at) };
}
