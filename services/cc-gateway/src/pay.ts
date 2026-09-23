/**
 * The two-leg payment (F7, B3 §6): merchant rings up → signed `org.bioregion.pay.request` (QR) → the customer's
 * wallet signs an `org.bioregion.pay.authorization` carrying a presentation bound to the invoice → the gateway
 * verifies, checks limits and acceptance, settles double-entry and issues a signed `org.bioregion.pay.receipt`.
 * The remaining dollars go on the merchant's own rails; `/pay/:id/tender` records that leg via the POS adapter.
 */
import { digestMultibase, verifyDocument, type DataIntegrityProof, type VerifiablePresentation } from '@passport/credential-core';
import { PayAuthorizationMessageSchema, type PayRequestMessage } from '@passport/lexicons';
import { findEntry, json, merchantScope, num, sealMessage, toIso, type EntryRow } from '@passport/pos-adapter';
import { ServiceError, type SessionClaims } from '@passport/service-kit';
import { verifyDTG } from '@passport/verifier-sdk';
import { getAccount, overLimitError, raiseBand, settle, type AccountRow } from './ledger.js';
import { getEnterprise, getRules } from './merchant.js';
import { addMs, bad, cents, DAY_MS, floorCents, isObject, optString, tid, type GatewayContext, type GatewayDeps } from './util.js';

export const REQUEST_TTL_MS = 10 * 60_000;
/** An offline authorization may be synced up to this long after the payer signed it. */
export const OFFLINE_SYNC_WINDOW_MS = DAY_MS;
const SKEW_MS = 5 * 60_000;

export const podDomain = (ctx: GatewayContext): string => `${ctx.slug}.${ctx.platformDomain}`;

const REQUIRES = ['MembershipCredential:pod', 'AuthorityCredential:credit:account'];

/** Removes the `sig` mirror so the DataIntegrityProof can be checked over the rest. */
const withoutSig = <T extends Record<string, any>>(doc: T): T => {
  const { sig: _s, ...rest } = doc;
  return rest as T;
};

function requireReceiveAuthority(s: SessionClaims, enterpriseDid: string): void {
  if (!s.authorities.includes(`pay:receive@${enterpriseDid}`)) {
    throw new ServiceError(403, 'MISSING_AUTHORITY', 'This needs authority to receive payments at this enterprise, which your passport does not carry.');
  }
}

/** `POST /pay/request`: the merchant side. Session must carry `pay:receive@<enterpriseDid>` (owner or staff). */
export async function createPayRequest(ctx: GatewayContext, deps: GatewayDeps, s: SessionClaims, body: unknown) {
  if (!isObject(body) || typeof body['enterpriseDid'] !== 'string') throw bad('BAD_REQUEST', 'A payment request needs the enterprise and the total sale.');
  const enterpriseDid = body['enterpriseDid'];
  requireReceiveAuthority(s, enterpriseDid);
  if (!(await merchantScope(ctx, s)).includes(enterpriseDid)) {
    throw new ServiceError(403, 'NOT_MERCHANT', 'Your staff authority for this enterprise has been withdrawn.');
  }
  const e = await getEnterprise(ctx, enterpriseDid);
  if (!e.accepts_local_credit) throw new ServiceError(403, 'NOT_ACCEPTING', 'This enterprise is not accepting credits right now.');
  const total = body['totalSale'];
  if (!isObject(total) || total['unit'] !== 'USD' || typeof total['value'] !== 'number' || !(total['value'] > 0)) {
    throw bad('BAD_REQUEST', 'The total sale must be a dollar amount above zero.');
  }
  const totalSale = { unit: 'USD', value: cents(total['value']) };
  const rules = await getRules(ctx, enterpriseDid);
  if (totalSale.value < rules.minSale) {
    throw bad('BELOW_MIN_SALE', `This enterprise takes credits on sales of ${rules.minSale} dollars or more.`);
  }
  const shareCap = floorCents(totalSale.value * rules.maxShare);
  const creditValue = body['creditValue'];
  if (creditValue !== undefined && (typeof creditValue !== 'number' || !Number.isFinite(creditValue) || creditValue <= 0)) {
    throw bad('BAD_REQUEST', 'The credit share must be a number above zero.');
  }
  if (typeof creditValue === 'number' && cents(creditValue) > shareCap) {
    throw bad('OVER_SHARE', `This enterprise takes credits for at most ${Math.round(rules.maxShare * 100)}% of a sale (${shareCap} credits here).`);
  }
  const acct = await getAccount(ctx, enterpriseDid);
  if (!acct) throw new ServiceError(409, 'NO_ACCOUNT', 'This enterprise has no credit account in this pod.');
  const headroom = floorCents(rules.ceiling - num(acct.balance));
  const value = floorCents(Math.min(typeof creditValue === 'number' ? cents(creditValue) : shareCap, headroom));
  if (!(value > 0)) throw new ServiceError(403, 'MERCHANT_CEILING', 'This enterprise has reached its acceptance ceiling for now.');

  const invoice = optString(body['invoice']) ?? `inv_${tid(ctx.now)}`;
  if ((await ctx.db.query('SELECT 1 FROM ledger_entries WHERE invoice = $1', [invoice])).length) {
    throw new ServiceError(409, 'INVOICE_EXISTS', 'That invoice number has already been used.');
  }
  const now = ctx.now();
  const unit = ctx.manifest.currency.unit;
  const unsigned: PayRequestMessage = {
    type: 'org.bioregion.pay.request',
    merchant: enterpriseDid,
    pod: ctx.podDid,
    node: ctx.manifest.currency.node,
    amount: { unit, value },
    totalSale,
    invoice,
    expires: addMs(now, REQUEST_TTL_MS),
    acceptance: { maxShare: rules.maxShare, requires: [...REQUIRES] },
  };
  // The pod signs on the enterprise's behalf (the enterprise DID holds no key); `sig` mirrors the proof value.
  const request = sealMessage(deps.podSigner, unsigned as PayRequestMessage & Record<string, any>, now.toISOString());
  const [row] = await ctx.db.query<{ id: string | number }>(
    `INSERT INTO ledger_entries (payee_did, amount, unit, invoice, request, status, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'requested', $6) RETURNING id`,
    [enterpriseDid, value, unit, invoice, JSON.stringify(request), now.toISOString()],
  );
  return { request, qr: JSON.stringify(request), transactionId: String(row!.id) };
}

/**
 * `POST /pay/authorize` `{ authorization }`. Checks, in order, each refusing with one sentence:
 * BAD_REQUEST_SIG → REQUEST_EXPIRED → INVOICE_UNKNOWN / ALREADY_PAID → presentation (verifyDTG) + PAYER_MISMATCH
 * (+ BAD_AUTHORIZATION_SIG) → AMOUNT_MISMATCH → NO_ACCOUNT → OVER_LIMIT → MERCHANT_CEILING (→ OFFLINE_ALLOWANCE),
 * then settles and issues the receipt in one transaction.
 *
 * The payer is `transfer.from`: a member's own account (presentation subject = `transfer.from` = session), or an
 * enterprise account spent by its owner (presentation subject = session = the enterprise's `owner_did`) — the
 * latter is how enterprises re-spend what they earn.
 *
 * Offline (`authorization.offline === true`): the presentation's challenge need not be the invoice (it may be a
 * stored nonce; signatures, membership and authority are still checked), expiry is judged at `transfer.createdAt`
 * (which must be within the last 24 h), and the enterprise accepts at most `acceptance_rules.offline_allowance`
 * credits per UTC day of offline payments.
 */
export async function authorizePayment(ctx: GatewayContext, deps: GatewayDeps, s: SessionClaims, body: unknown) {
  const auth = isObject(body) ? body['authorization'] : undefined;
  if (!isObject(auth) || !PayAuthorizationMessageSchema.safeParse(auth).success || !isObject(auth['request'])) {
    throw bad('BAD_REQUEST', 'This payment authorization is incomplete or malformed.');
  }
  const request = auth['request'] as Record<string, any>;
  const transfer = auth['transfer'] as { from: string; to: string; amount: { unit: string; value: number }; invoice: string; createdAt: string };
  const offline = auth['offline'] === true;
  const now = ctx.now();

  // 1. request signed by this pod
  const reqSig = isObject(request['proof'])
    ? await verifyDocument(withoutSig(request) as { proof: DataIntegrityProof }, deps.resolver, { proofPurpose: 'assertionMethod' })
    : { ok: false as const };
  if (!reqSig.ok || reqSig.controller !== ctx.podDid || request['pod'] !== ctx.podDid) {
    throw bad('BAD_REQUEST_SIG', 'This payment request was not signed by this pod, so it cannot be paid here.');
  }

  // 2. not expired
  const expires = Date.parse(String(request['expires']));
  if (offline) {
    const signedAt = Date.parse(transfer.createdAt);
    if (Number.isNaN(signedAt) || signedAt > now.getTime() + SKEW_MS || now.getTime() - signedAt > OFFLINE_SYNC_WINDOW_MS) {
      throw new ServiceError(410, 'REQUEST_EXPIRED', 'This offline payment was signed too long ago to be accepted; ask the merchant to ring it up again.');
    }
    if (!(expires > signedAt)) throw new ServiceError(410, 'REQUEST_EXPIRED', 'This payment request had expired when it was signed; ask the merchant to ring it up again.');
  } else if (!(expires > now.getTime())) {
    throw new ServiceError(410, 'REQUEST_EXPIRED', 'This payment request has expired; ask the merchant to ring it up again.');
  }

  // 3. invoice known and unpaid
  const invoice = String(request['invoice']);
  const entry = await findEntry(ctx, invoice);
  if (!entry || entry.invoice !== invoice) throw new ServiceError(404, 'INVOICE_UNKNOWN', 'This pod has no record of that invoice.');
  if (entry.status === 'settled') throw new ServiceError(409, 'ALREADY_PAID', 'This invoice has already been paid.');
  if (entry.status !== 'requested') throw new ServiceError(404, 'INVOICE_UNKNOWN', 'This pod has no open payment request for that invoice.');
  if (digestMultibase(json(entry.request)) !== digestMultibase(request)) {
    throw bad('BAD_REQUEST_SIG', 'This payment request does not match the one the merchant issued.');
  }
  if (transfer.invoice !== invoice) throw bad('INVOICE_MISMATCH', 'This authorization is for a different invoice than the request it carries.');
  if (transfer.to !== request['merchant'] || transfer.to !== entry.payee_did) {
    throw bad('PAYEE_MISMATCH', 'This authorization pays someone other than the merchant who asked.');
  }

  // 4. presentation and payer identity
  const payerAccount = await getAccount(ctx, transfer.from);
  let actor = transfer.from;
  if (payerAccount?.kind === 'enterprise') {
    const payerEnterprise = await getEnterprise(ctx, transfer.from);
    if (!payerEnterprise.owner_did) throw new ServiceError(403, 'PAYER_MISMATCH', 'This enterprise has no owner who can spend its credits.');
    actor = payerEnterprise.owner_did;
  }
  const domain = podDomain(ctx);
  const verified = await verifyDTG(
    auth['presentation'] as VerifiablePresentation,
    {
      acceptedPods: [ctx.podDid],
      requireAuthority: ['credit:account'],
      ...(offline ? { allowReplay: true } : { challenge: invoice, domain }),
      podNames: { [ctx.podDid]: ctx.manifest.identity.name },
    },
    { resolver: deps.resolver, now: ctx.now, ...(deps.statusFetch ? { statusFetch: deps.statusFetch } : {}) },
  );
  if (!verified.ok || !verified.subject) {
    const code = verified.error?.code ?? 'BAD_PROOF';
    const status = ['MISSING_AUTHORITY', 'POD_MISMATCH', 'BROADENED_ATTENUATION', 'CHAIN_TOO_DEEP'].includes(code) ? 403 : 401;
    throw new ServiceError(status, code, verified.error?.message ?? 'This presentation was refused.');
  }
  if (verified.subject !== actor || verified.subject !== s.subject || auth['payer'] !== transfer.from) {
    throw new ServiceError(403, 'PAYER_MISMATCH', 'This authorization was signed for someone other than the person presenting it.');
  }
  const authSig = isObject(auth['proof'])
    ? await verifyDocument(withoutSig(auth) as { proof: DataIntegrityProof }, deps.resolver)
    : { ok: false as const };
  if (!authSig.ok || authSig.controller !== actor) {
    throw bad('BAD_AUTHORIZATION_SIG', 'This authorization is not signed by the person paying.');
  }

  // 5. amount
  const amount = num(entry.amount);
  if (transfer.amount.unit !== ctx.manifest.currency.unit || cents(transfer.amount.value) !== amount || cents(Number(request['amount']?.value)) !== amount) {
    throw bad('AMOUNT_MISMATCH', `This authorization is for a different amount than the ${amount} credits requested.`);
  }

  return ctx.db.transaction(async () => {
    // 6–8. accounts, limit, ceiling (rows locked for the rest of the transaction)
    if (!payerAccount) throw new ServiceError(409, 'NO_ACCOUNT', 'You do not have a credit account in this pod yet; open one first.');
    if (payerAccount.kind === 'member') await raiseBand(ctx, transfer.from, verified.authorities);
    const locked = await ctx.db.query<AccountRow>('SELECT * FROM accounts WHERE did = ANY($1::text[]) ORDER BY did FOR UPDATE', [[transfer.from, transfer.to]]);
    const payer = locked.find((r) => r.did === transfer.from)!;
    const payee = locked.find((r) => r.did === transfer.to);
    if (!payee) throw new ServiceError(409, 'NO_ACCOUNT', 'The receiving enterprise has no credit account in this pod.');
    const balance = num(payer.balance);
    const limit = num(payer.credit_limit);
    if (cents(balance - amount) < -limit) throw overLimitError(balance, amount, limit);
    const rules = await getRules(ctx, transfer.to);
    if (cents(num(payee.balance) + amount) > rules.ceiling) {
      throw new ServiceError(403, 'MERCHANT_CEILING', 'This enterprise has reached its acceptance ceiling for now.');
    }
    if (offline) {
      const day = now.toISOString().slice(0, 10);
      const [{ sum } = { sum: 0 }] = await ctx.db.query<{ sum: string | number | null }>(
        `SELECT COALESCE(SUM(amount), 0) AS sum FROM ledger_entries
          WHERE payee_did = $1 AND status = 'settled' AND ("authorization"->>'offline')::boolean IS TRUE
            AND created_at >= $2::timestamptz AND created_at < $2::timestamptz + interval '1 day'`,
        [transfer.to, `${day}T00:00:00Z`],
      );
      if (cents(num(sum) + amount) > rules.offlineAllowance) {
        throw new ServiceError(403, 'OFFLINE_ALLOWANCE', `This enterprise has used today's offline allowance of ${rules.offlineAllowance} credits; pay again once online.`);
      }
    }

    const settled = await settle(ctx, { from: transfer.from, to: transfer.to, amount, invoice, unit: entry.unit ?? ctx.manifest.currency.unit, entryId: String(entry.id) });
    const receipt = sealMessage(
      deps.podSigner,
      {
        type: 'org.bioregion.pay.receipt',
        transactionId: settled.entryId,
        invoice,
        amount: { unit: entry.unit ?? ctx.manifest.currency.unit, value: amount },
        totalSale: request['totalSale'],
        payer: transfer.from,
        payee: transfer.to,
        createdAt: settled.settledAt,
        posWriteBack: { status: 'pending' },
      } as Record<string, any>,
      settled.settledAt,
    );
    await ctx.db.query(`UPDATE ledger_entries SET "authorization" = $2::jsonb, receipt = $3::jsonb WHERE id = $1`, [
      settled.entryId,
      JSON.stringify(auth),
      JSON.stringify(receipt),
    ]);
    return { receipt, balance: settled.payer.balance };
  });
}

/** Payer, or owner/staff of the payee, may read an entry. */
export async function requireParty(ctx: GatewayContext, s: SessionClaims, entry: EntryRow): Promise<'payer' | 'merchant'> {
  if (entry.payer_did && entry.payer_did === s.subject) return 'payer';
  if (entry.payee_did && (await merchantScope(ctx, s)).includes(entry.payee_did)) return 'merchant';
  // An enterprise's owner is also the payer when the enterprise spent.
  if (entry.payer_did && (await merchantScope(ctx, s)).includes(entry.payer_did)) return 'payer';
  throw new ServiceError(403, 'NOT_A_PARTY', 'Only the payer or the receiving enterprise can see this payment.');
}

export async function loadEntry(ctx: GatewayContext, id: string): Promise<EntryRow> {
  const entry = await findEntry(ctx, id);
  if (!entry) throw new ServiceError(404, 'NOT_FOUND', 'There is no payment with that id in this pod.');
  return entry;
}

/** `GET /pay/:id/receipt` */
export async function getReceipt(ctx: GatewayContext, s: SessionClaims, id: string) {
  const entry = await loadEntry(ctx, id);
  await requireParty(ctx, s, entry);
  if (entry.status !== 'settled' || !entry.receipt) throw new ServiceError(409, 'NOT_SETTLED', 'This payment has not settled yet, so there is no receipt.');
  return {
    receipt: json(entry.receipt),
    externalTender: entry.external_tender ? json(entry.external_tender) : null,
    createdAt: toIso(entry.created_at),
  };
}
