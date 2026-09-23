import {
  attenuate,
  buildAuthority,
  buildMembershipAck,
  buildMembershipGrant,
  createPresentation,
  createResolver,
  didWebDocument,
  digestMultibase,
  generateKeyPair,
  keyPairForDid,
  signDocument,
  verifyDocument,
  type KeyPair,
  type VerifiableCredential,
} from '@passport/credential-core';
import { createTestDb, createTestPod, withPod, type Db } from '@passport/db';
import { PayReceiptMessageSchema, PayRequestMessageSchema } from '@passport/lexicons';
import { createPosAdapterRoutes } from '@passport/pos-adapter';
import { errorResult, type Route, type SessionClaims } from '@passport/service-kit';
import { boulderManifest, defaultTrustPolicy } from '@passport/tenant-config';
import { verifyDTG } from '@passport/verifier-sdk';
import { tierDefaultActions, type Tier } from '@passport/vocab';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settle } from './ledger.js';
import { createEnterprise } from './merchant.js';
import { createGatewayRoutes } from './routes.js';
import { smokeTransfer } from './smoke.js';
import { csvCell, exposure, reSpendRatio, unmetDemandStatus } from './steward.js';
import type { GatewayContext, GatewayDeps, GatewayRoute } from './util.js';

const SLUG = 'boulder';
const PLATFORM = 'bioregionalpassport.org';
const DOMAIN = `${SLUG}.${PLATFORM}`;
const POD_DID = boulderManifest.identity.did;
const NOW = new Date('2026-09-22T18:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const podKey = keyPairForDid(POD_DID, generateKeyPair().privateKey);
const podSigner: GatewayDeps['podSigner'] = { did: podKey.did, kid: podKey.kid, sign: (doc, opts) => signDocument(doc, podKey, opts) };
const resolver = createResolver({ staticDocs: { [POD_DID]: didWebDocument(POD_DID, podKey.publicKeyMultibase) } });
const deps: GatewayDeps = { resolver, podSigner };
const policy = defaultTrustPolicy(POD_DID);

let db: Db;
const routes: GatewayRoute[] = createGatewayRoutes(deps);
const posRoutes = createPosAdapterRoutes({ podSigner }) as unknown as GatewayRoute[];

beforeAll(async () => {
  db = await createTestDb();
  for (const slug of [SLUG, 'respend', 'kills', 'smoke']) await createTestPod(db, slug);
});
afterAll(async () => {
  await db.close();
});

const ctxFor = (tx: Db, now: Date, slug = SLUG): GatewayContext => ({
  slug,
  podDid: POD_DID,
  db: tx,
  manifest: boulderManifest,
  policy,
  now: () => now,
  platformDomain: PLATFORM,
});
const run = <T>(fn: (ctx: GatewayContext) => Promise<T>, now = NOW, slug = SLUG) => withPod(db, slug, (tx) => fn(ctxFor(tx, now, slug)));

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(':')) params[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

async function call(
  method: string,
  fullPath: string,
  opts: { body?: unknown; session?: SessionClaims; now?: Date; table?: Route<GatewayContext>[]; slug?: string } = {},
): Promise<{ status: number; body: any; headers?: Record<string, string> }> {
  const [path, qs] = fullPath.split('?') as [string, string | undefined];
  for (const r of opts.table ?? routes) {
    const params = r.method === method ? match(r.path, path) : null;
    if (!params) continue;
    const req = { params, query: Object.fromEntries(new URLSearchParams(qs ?? '')), body: opts.body, ...(opts.session ? { session: opts.session } : {}) };
    return run(
      async (ctx) => {
        try {
          const out = await r.handler(ctx, req);
          return { status: out.status ?? 200, body: out.body, ...(out.headers ? { headers: out.headers } : {}) };
        } catch (e) {
          if (!(e instanceof Error) || e.name !== 'ServiceError') throw e;
          return errorResult(e);
        }
      },
      opts.now ?? NOW,
      opts.slug ?? SLUG,
    );
  }
  throw new Error(`no route ${method} ${path}`);
}

// ── personas, credentials, sessions ────────────────────────────────────────────────────────────────

interface Persona {
  key: KeyPair;
  tier: Tier;
  creds: VerifiableCredential[];
  extra: string[];
}

function persona(tier: Tier): Persona {
  const key = generateKeyPair();
  const validFrom = iso(NOW.getTime() - DAY);
  const validUntil = iso(NOW.getTime() + 60 * DAY);
  const grant = podSigner.sign(
    buildMembershipGrant({ pod: POD_DID, member: key.did, bioregion: SLUG, placeIds: [], governance: boulderManifest.governance.url, validFrom, validUntil }),
  );
  const ack = signDocument(buildMembershipAck({ member: key.did, pod: POD_DID, grantDigest: digestMultibase(grant), validFrom, validUntil }), key);
  const vac = podSigner.sign(
    buildAuthority({ issuer: POD_DID, subject: key.did, scope: POD_DID, actions: tierDefaultActions(tier), validFrom, validUntil, tier }),
  );
  return { key, tier, creds: [grant, ack, vac], extra: [] };
}

const sessionOf = (p: Persona): SessionClaims => ({
  subject: p.key.did,
  pod: POD_DID,
  tier: p.tier,
  authorities: [...tierDefaultActions(p.tier), ...p.extra],
});

const stewardSession: SessionClaims = { subject: generateKeyPair().did, pod: POD_DID, tier: 'T3', authorities: tierDefaultActions('T3') };

function authorization(payer: Persona, request: any, o: { from?: string; amount?: any; invoice?: string; challenge?: string; offline?: boolean; signer?: KeyPair } = {}) {
  const vp = createPresentation(payer.creds, payer.key, { challenge: o.challenge ?? request.invoice, domain: DOMAIN });
  const unsigned: Record<string, any> = {
    type: 'org.bioregion.pay.authorization',
    request,
    payer: o.from ?? payer.key.did,
    transfer: {
      from: o.from ?? payer.key.did,
      to: request.merchant,
      amount: o.amount ?? request.amount,
      invoice: o.invoice ?? request.invoice,
      createdAt: NOW.toISOString(),
    },
    presentation: vp,
    ...(o.offline ? { offline: true } : {}),
  };
  const signed = signDocument(unsigned, o.signer ?? payer.key);
  return { authorization: { ...signed, sig: signed.proof.proofValue } };
}

async function balanceOf(did: string, slug = SLUG): Promise<number> {
  return run(async (ctx) => Number((await ctx.db.query('SELECT balance FROM accounts WHERE did = $1', [did]))[0]?.balance), NOW, slug);
}

// ── shared scenario: owner (T2, L2), enterprise (services, 0.75), customer (T1, L1) ────────────────

const owner = persona('T2');
const customer = persona('T1');
let enterpriseDid = '';
let rootVac: VerifiableCredential;

async function ringUp(totalSale: number, extra: Record<string, unknown> = {}, now = NOW) {
  return call('POST', '/pay/request', { session: sessionOf(owner), now, body: { enterpriseDid, totalSale: { unit: 'USD', value: totalSale }, ...extra } });
}

describe('accounts and merchant setup', () => {
  it('opens a member account with the limit of the highest band (idempotent)', async () => {
    const res = await call('POST', '/accounts/open', { session: sessionOf(customer), body: { credentials: customer.creds } });
    expect(res.status).toBe(201);
    expect(res.body.account).toMatchObject({ did: customer.key.did, kind: 'member', band: 'L1', balance: 0, limit: 100, available: 100 });
    const again = await call('POST', '/accounts/open', { session: sessionOf(customer), body: { credentials: customer.creds } });
    expect(again.status).toBe(200);
    const o = await call('POST', '/accounts/open', { session: sessionOf(owner), body: { credentials: owner.creds } });
    expect(o.body.account).toMatchObject({ band: 'L2', limit: 400 });
  });

  it('refuses to open an account without credit:account', async () => {
    const res = await call('POST', '/accounts/open', { session: { subject: 'did:key:zX', pod: POD_DID, tier: 'T0', authorities: [] } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MISSING_AUTHORITY');
  });

  it('creates an enterprise with rules, account, open record and a root pay:receive VAC', async () => {
    const res = await call('POST', '/merchant/enterprises', {
      session: sessionOf(owner),
      body: { credentials: owner.creds, name: 'Moxie Bread', categories: ['bakery'], acceptanceCategory: 'services', placeId: 'huc12:101900050301', lat: 40.0, lon: -105.2 },
    });
    expect(res.status).toBe(201);
    const { enterprise, vac } = res.body;
    enterpriseDid = enterprise.did;
    rootVac = vac;
    expect(enterpriseDid).toMatch(/^did:key:z/);
    // Enterprises open with no credit line; default ceiling = 80% × owner's L2 (400) × 3.
    expect(enterprise.account).toMatchObject({ kind: 'enterprise', limit: 0, balance: 0 });
    expect(enterprise.rules).toMatchObject({ maxShare: 0.75, category: 'services', ceiling: 960, offlineAllowance: 50 });
    expect(vac.issuer).toBe(POD_DID);
    expect(vac.credentialSubject).toMatchObject({ id: owner.key.did, authority: { scope: enterpriseDid, actions: ['pay:receive'] } });
    expect((await verifyDocument(vac, resolver)).ok).toBe(true);
    const rec = await run((ctx) => ctx.db.query(`SELECT * FROM records WHERE collection = 'enterprise'`));
    expect(rec).toHaveLength(1);
    expect(rec[0].record).toMatchObject({ name: 'Moxie Bread', did: enterpriseDid, acceptsLocalCredit: true, acceptanceShare: 0.75, bioregion: SLUG });
    const log = await run((ctx) => ctx.db.query('SELECT * FROM vac_issuance_log WHERE subject_did = $1', [owner.key.did]));
    expect(log).toHaveLength(1);
    // The owner's wallet now holds the root VAC; their next session carries `pay:receive@<enterprise>`.
    owner.creds.push(vac);
    const verified = await verifyDTG(createPresentation(owner.creds, owner.key, { challenge: 'c', domain: DOMAIN }), { acceptedPods: [POD_DID], requireAuthority: [`pay:receive@${enterpriseDid}`], challenge: 'c', domain: DOMAIN }, { resolver, now: () => NOW });
    expect(verified.ok).toBe(true);
    expect(verified.authorities).toContain(`pay:receive@${enterpriseDid}`);
    owner.extra.push(`pay:receive@${enterpriseDid}`);
  });

  it('refuses a T0 session opening an enterprise', async () => {
    const res = await call('POST', '/merchant/enterprises', {
      session: { subject: 'did:key:zT0', pod: POD_DID, tier: 'T0', authorities: ['credit:account'] },
      body: { name: 'X', categories: ['x'], acceptanceCategory: 'retail' },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TIER_TOO_LOW');
  });

  it('records a commitment and lists the enterprise with exposure', async () => {
    const c = await call('POST', '/merchant/commitment', { session: sessionOf(owner), body: { enterpriseDid, text: 'We accept credits for bread and spend them on local flour.' } });
    expect(c.status).toBe(201);
    const mine = await call('GET', '/merchant/enterprises/mine', { session: sessionOf(owner) });
    expect(mine.body.enterprises).toHaveLength(1);
    expect(mine.body.enterprises[0]).toMatchObject({ did: enterpriseDid, role: 'owner', exposure: { balance: 0, ceiling: 960, pct: 0 } });
    expect(mine.body.enterprises[0].commitment.text).toMatch(/local flour/);
  });
});

describe('two-leg payment', () => {
  let paidId = '';

  it('pays within limits: request → authorize → signed receipt, balances ±', async () => {
    const req = await ringUp(40);
    expect(req.status).toBe(201);
    const request = req.body.request;
    expect(PayRequestMessageSchema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({ merchant: enterpriseDid, pod: POD_DID, amount: { unit: 'credit', value: 30 }, totalSale: { unit: 'USD', value: 40 } });
    expect(JSON.parse(req.body.qr)).toEqual(request);
    expect(request.acceptance).toEqual({ maxShare: 0.75, requires: ['MembershipCredential:pod', 'AuthorityCredential:credit:account'] });

    const res = await call('POST', '/pay/authorize', { session: sessionOf(customer), body: authorization(customer, request) });
    expect(res.status).toBe(200);
    const receipt = res.body.receipt;
    expect(PayReceiptMessageSchema.safeParse(receipt).success).toBe(true);
    expect(receipt).toMatchObject({ invoice: request.invoice, amount: { value: 30 }, payer: customer.key.did, payee: enterpriseDid, posWriteBack: { status: 'pending' } });
    const { sig, ...rest } = receipt;
    expect(sig).toBe(receipt.proof.proofValue);
    expect((await verifyDocument(rest, resolver)).controller).toBe(POD_DID);
    paidId = receipt.transactionId;

    expect(await balanceOf(customer.key.did)).toBe(-30);
    expect(await balanceOf(enterpriseDid)).toBe(30);
    const [{ total }] = await run((ctx) => ctx.db.query('SELECT SUM(balance) AS total FROM accounts'));
    expect(Number(total)).toBe(0);

    const stmt = await call('GET', '/accounts/me/statement', { session: sessionOf(customer) });
    expect(stmt.body.account).toMatchObject({ balance: -30, limit: 100, available: 70 });
    expect(stmt.body.entries).toHaveLength(1);
    expect(stmt.body.entries[0]).toMatchObject({ direction: 'out', payee: enterpriseDid, amount: 30, receiptId: paidId, status: 'settled' });
  });

  it('refuses paying the same invoice twice', async () => {
    const entry = await run((ctx) => ctx.db.query('SELECT request FROM ledger_entries WHERE id = $1', [paidId]));
    const res = await call('POST', '/pay/authorize', { session: sessionOf(customer), body: authorization(customer, entry[0].request) });
    expect(res.body.code).toBe('ALREADY_PAID');
  });

  it('shows the receipt to the payer and merchant, records the tender, and clears reconciliation', async () => {
    expect((await call('GET', `/pay/${paidId}/receipt`, { session: sessionOf(customer) })).status).toBe(200);
    expect((await call('GET', `/pay/${paidId}/receipt`, { session: sessionOf(owner) })).status).toBe(200);
    const stranger = await call('GET', `/pay/${paidId}/receipt`, { session: sessionOf(persona('T1')) });
    expect(stranger.body.code).toBe('NOT_A_PARTY');

    const pending = await call('GET', '/reconcile/pending', { session: sessionOf(owner) });
    expect(pending.body.pending.map((p: any) => p.transactionId)).toEqual([paidId]);
    expect(pending.body.pending[0].dollarsDue).toBe(10);

    const wrong = await call('POST', `/pay/${paidId}/tender`, { session: sessionOf(owner), body: { provider: 'square', ref: 'sq_123', dollars: 12 } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('TENDER_MISMATCH');
    const tender = await call('POST', `/pay/${paidId}/tender`, { session: sessionOf(owner), body: { provider: 'square', ref: 'sq_123', dollars: 10 } });
    expect(tender.status).toBe(200);
    expect(tender.body.externalTender).toMatchObject({ provider: 'square', adapter: 'manual', ref: 'sq_123', status: 'recorded' });
    expect(tender.body.receipt.posWriteBack).toEqual({ status: 'recorded', provider: 'square', ref: 'sq_123' });
    const { sig: _s, ...rest } = tender.body.receipt;
    expect((await verifyDocument(rest, resolver)).ok).toBe(true);
    expect((await call('GET', '/reconcile/pending', { session: sessionOf(owner) })).body.pending).toEqual([]);
    const again = await call('POST', `/pay/${paidId}/tender`, { session: sessionOf(owner), body: { provider: 'manual', dollars: 10 } });
    expect(again.body.code).toBe('ALREADY_RECORDED');
  });

  it('refuses a payment over the payer limit with the sentence', async () => {
    const req = await ringUp(100); // 75 credits; customer is at −30 with a limit of 100
    const res = await call('POST', '/pay/authorize', { session: sessionOf(customer), body: authorization(customer, req.body.request) });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 'OVER_LIMIT', message: 'This payment would take you 5 credits past your limit of 100.' });
    expect(await balanceOf(customer.key.did)).toBe(-30);
  });

  it('refuses an expired request', async () => {
    const req = await ringUp(8);
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const res = await call('POST', '/pay/authorize', { session: sessionOf(customer), now: later, body: authorization(customer, req.body.request) });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('REQUEST_EXPIRED');
  });

  it('refuses wrong amount, wrong invoice, unknown invoice, a tampered request and a stranger', async () => {
    const req = await ringUp(8);
    const request = req.body.request;
    const wrongAmount = await call('POST', '/pay/authorize', { session: sessionOf(customer), body: authorization(customer, request, { amount: { unit: 'credit', value: 1 } }) });
    expect(wrongAmount.body.code).toBe('AMOUNT_MISMATCH');
    const wrongInvoice = await call('POST', '/pay/authorize', { session: sessionOf(customer), body: authorization(customer, request, { invoice: 'inv_other' }) });
    expect(wrongInvoice.body.code).toBe('INVOICE_MISMATCH');
    const tampered = await call('POST', '/pay/authorize', { session: sessionOf(customer), body: authorization(customer, { ...request, amount: { unit: 'credit', value: 0.5 } }) });
    expect(tampered.body.code).toBe('BAD_REQUEST_SIG');
    const { proof: _p, sig: _s, ...unsigned } = request;
    const forged = podSigner.sign({ ...unsigned, invoice: 'inv_never_issued' });
    const unknown = await call('POST', '/pay/authorize', { session: sessionOf(customer), body: authorization(customer, { ...forged, sig: forged.proof.proofValue }) });
    expect(unknown.body.code).toBe('INVOICE_UNKNOWN');
    const other = persona('T1');
    const stranger = await call('POST', '/pay/authorize', { session: sessionOf(customer), body: authorization(other, request) });
    expect(stranger.body.code).toBe('PAYER_MISMATCH');
    const wrongChallenge = await call('POST', '/pay/authorize', { session: sessionOf(customer), body: authorization(customer, request, { challenge: 'nope' }) });
    expect(wrongChallenge.body.code).toBe('BAD_CHALLENGE');
    const badSig = await call('POST', '/pay/authorize', { session: sessionOf(customer), body: authorization(customer, request, { signer: generateKeyPair() }) });
    expect(badSig.body.code).toBe('BAD_AUTHORIZATION_SIG');
    const overShare = await ringUp(10, { creditValue: 8 }); // services take at most 75% = 7.5
    expect(overShare.status).toBe(400);
    expect(overShare.body.code).toBe('OVER_SHARE');
  });

  it('refuses a request without pay:receive for that enterprise', async () => {
    const res = await call('POST', '/pay/request', { session: sessionOf(customer), body: { enterpriseDid, totalSale: { unit: 'USD', value: 10 } } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MISSING_AUTHORITY');
  });

  it('refuses at the merchant ceiling', async () => {
    const req = await ringUp(8); // 6 credits
    const lowered = await call('PUT', `/merchant/enterprises/${encodeURIComponent(enterpriseDid)}/rules`, { session: sessionOf(owner), body: { ceiling: 32 } });
    expect(lowered.body.rules.ceiling).toBe(32);
    const res = await call('POST', '/pay/authorize', { session: sessionOf(customer), body: authorization(customer, req.body.request) });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 'MERCHANT_CEILING', message: 'This enterprise has reached its acceptance ceiling for now.' });
    // A new request is clipped to the headroom (2 credits); at zero headroom the request itself is refused.
    expect((await ringUp(8)).body.request.amount.value).toBe(2);
    await call('PUT', `/merchant/enterprises/${encodeURIComponent(enterpriseDid)}/rules`, { session: sessionOf(owner), body: { ceiling: 30 } });
    expect((await ringUp(8)).body.code).toBe('MERCHANT_CEILING');
    await call('PUT', `/merchant/enterprises/${encodeURIComponent(enterpriseDid)}/rules`, { session: sessionOf(owner), body: { ceiling: 960 } });
  });

  it('lets an owner re-spend enterprise credits through the same authorization', async () => {
    const supplier = persona('T2');
    supplier.creds.length = 3;
    await call('POST', '/accounts/open', { session: sessionOf(supplier), body: { credentials: supplier.creds } });
    const created = await call('POST', '/merchant/enterprises', { session: sessionOf(supplier), body: { credentials: supplier.creds, name: 'Flour Mill', categories: ['flour'], acceptanceCategory: 'suppliers' } });
    const mill = created.body.enterprise.did;
    supplier.extra.push(`pay:receive@${mill}`);
    const req = await call('POST', '/pay/request', { session: sessionOf(supplier), body: { enterpriseDid: mill, totalSale: { unit: 'USD', value: 20 } } });
    expect(req.body.request.amount.value).toBe(7); // suppliers 0.35
    const res = await call('POST', '/pay/authorize', { session: sessionOf(owner), body: authorization(owner, req.body.request, { from: enterpriseDid }) });
    expect(res.status).toBe(200);
    expect(await balanceOf(enterpriseDid)).toBe(23);
    expect(await balanceOf(mill)).toBe(7);
  });

  it('accepts offline payments up to the daily offline allowance', async () => {
    await call('PUT', `/merchant/enterprises/${encodeURIComponent(enterpriseDid)}/rules`, { session: sessionOf(owner), body: { offlineAllowance: 10 } });
    const payer = persona('T2');
    await call('POST', '/accounts/open', { session: sessionOf(payer), body: { credentials: payer.creds } });
    const notOffered = await ringUp(8);
    const refusedNotOffered = await call('POST', '/pay/authorize', { session: sessionOf(payer), body: authorization(payer, notOffered.body.request, { offline: true, challenge: 'stored-nonce' }) });
    expect(refusedNotOffered.body.code).toBe('OFFLINE_NOT_OFFERED');
    const first = await ringUp(8, { offline: true }); // 6 credits
    expect(first.body.request.acceptance.offline).toBe(true);
    const ok = await call('POST', '/pay/authorize', { session: sessionOf(payer), body: authorization(payer, first.body.request, { offline: true, challenge: 'stored-nonce' }) });
    expect(ok.status).toBe(200);
    const second = await ringUp(8, { offline: true });
    const refused = await call('POST', '/pay/authorize', { session: sessionOf(payer), body: authorization(payer, second.body.request, { offline: true, challenge: 'stored-nonce' }) });
    expect(refused.body.code).toBe('OFFLINE_ALLOWANCE');
    await call('PUT', `/merchant/enterprises/${encodeURIComponent(enterpriseDid)}/rules`, { session: sessionOf(owner), body: { offlineAllowance: 50 } });
  });
});

const enc = encodeURIComponent;

/** Owner attenuates their root VAC to a staff member; returns the staff persona, VAC and a verifier-derived session. */
async function makeStaff(days = 14) {
  const staff = persona('T1');
  const staffVac = signDocument(
    attenuate(rootVac, { issuerKey: owner.key, subject: staff.key.did, actions: ['pay:receive'], validFrom: NOW.toISOString(), validUntil: iso(NOW.getTime() + days * DAY) }),
    owner.key,
  );
  staff.creds.push(rootVac, staffVac);
  const v = await verifyDTG(
    createPresentation(staff.creds, staff.key, { challenge: 'c', domain: DOMAIN }),
    { acceptedPods: [POD_DID], requireAuthority: [`pay:receive@${enterpriseDid}`], challenge: 'c', domain: DOMAIN },
    { resolver, now: () => NOW },
  );
  expect(v.ok).toBe(true);
  const session: SessionClaims = { subject: staff.key.did, pod: POD_DID, tier: v.tier!, authorities: v.authorities };
  return { staff, staffVac, session };
}

const register = (staffVac: VerifiableCredential) =>
  call('POST', `/merchant/enterprises/${enc(enterpriseDid)}/staff`, { session: sessionOf(owner), body: { vac: staffVac } });

describe('staff', () => {
  it('validates an owner-attenuated pay:receive VAC; staff ring up and read only their own sales', async () => {
    const { staff, staffVac, session } = await makeStaff();
    const res = await call('POST', `/merchant/enterprises/${enc(enterpriseDid)}/staff`, { session: sessionOf(owner), body: { staffDid: staff.key.did, vac: staffVac } });
    expect(res.status).toBe(201);
    expect(res.body.staff).toMatchObject({ staffDid: staff.key.did, digest: digestMultibase(staffVac) });
    expect(session.authorities).toContain(`pay:receive@${enterpriseDid}`);

    // Mutating staff requests must carry the registered staff VAC.
    const noVac = await call('POST', '/pay/request', { session, body: { enterpriseDid, totalSale: { unit: 'USD', value: 4 } } });
    expect(noVac.body.code).toBe('NOT_MERCHANT');
    const req = await call('POST', '/pay/request', { session, body: { enterpriseDid, totalSale: { unit: 'USD', value: 4 }, staffVac } });
    expect(req.status).toBe(201);
    const mine = await call('GET', '/merchant/enterprises/mine', { session });
    expect(mine.body.enterprises[0]).toMatchObject({ did: enterpriseDid, role: 'staff' });

    const paid = await call('POST', '/pay/authorize', { session: sessionOf(customer), body: authorization(customer, req.body.request) });
    expect(paid.status).toBe(200);
    const id = paid.body.receipt.transactionId;
    expect((await call('GET', `/pay/${id}/receipt`, { session })).status).toBe(200);
    expect((await call('GET', `/pay/${id}/receipt`, { session: sessionOf(owner) })).status).toBe(200);
    const other = await makeStaff();
    expect((await register(other.staffVac)).status).toBe(201);
    expect((await call('GET', `/pay/${id}/receipt`, { session: other.session })).body.code).toBe('NOT_A_PARTY');

    // Staff cannot spend the enterprise's credits.
    const sale = await ringUp(4);
    const spend = await call('POST', '/pay/authorize', { session, body: authorization(staff, sale.body.request, { from: enterpriseDid }) });
    expect(spend.body.code).toBe('PAYER_MISMATCH');

    // Removed staff can no longer ring up or read.
    await call('DELETE', `/merchant/enterprises/${enc(enterpriseDid)}/staff/${enc(staff.key.did)}`, { session: sessionOf(owner) });
    expect((await call('POST', '/pay/request', { session, body: { enterpriseDid, totalSale: { unit: 'USD', value: 4 }, staffVac } })).body.code).toBe('NOT_MERCHANT');
    expect((await call('GET', `/pay/${id}/receipt`, { session })).body.code).toBe('NOT_A_PARTY');

    // Re-adding after removal makes the grant active again.
    expect((await register(staffVac)).status).toBe(201);
    expect((await call('POST', '/pay/request', { session, body: { enterpriseDid, totalSale: { unit: 'USD', value: 4 }, staffVac } })).status).toBe(201);
  });

  it('gives nothing to a valid attenuated VAC the owner never registered, and removes unregistered staff', async () => {
    const ghost = await makeStaff();
    const res = await call('POST', '/pay/request', { session: ghost.session, body: { enterpriseDid, totalSale: { unit: 'USD', value: 4 }, staffVac: ghost.staffVac } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_MERCHANT');
    expect((await call('GET', '/merchant/enterprises/mine', { session: ghost.session })).body.enterprises).toEqual([]);
    const del = await call('DELETE', `/merchant/enterprises/${enc(enterpriseDid)}/staff/${enc(ghost.staff.key.did)}`, { session: sessionOf(owner) });
    expect(del.status).toBe(200);
    const rows = await run((ctx) => ctx.db.query('SELECT * FROM merchant_staff WHERE staff_did = $1', [ghost.staff.key.did]));
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it('refuses staff authority longer than 30 days', async () => {
    const staff = persona('T1');
    const tooLong = signDocument(
      buildAuthority({
        issuer: owner.key.did,
        subject: staff.key.did,
        scope: enterpriseDid,
        actions: ['pay:receive'],
        validFrom: NOW.toISOString(),
        validUntil: iso(NOW.getTime() + 45 * DAY),
        parent: digestMultibase(rootVac),
        depth: 1,
        bioregionScope: 'directed',
      }),
      owner.key,
    );
    expect((await register(tooLong)).body.code).toBe('TOO_LONG');
  });

  it('refuses a staff VAC not derived from the owner root, or signed by someone else', async () => {
    const staff = persona('T1');
    const stray = podSigner.sign(buildAuthority({ issuer: POD_DID, subject: owner.key.did, scope: enterpriseDid, actions: ['pay:receive'], validFrom: NOW.toISOString(), validUntil: iso(NOW.getTime() + 20 * DAY) }));
    const fromStray = signDocument(attenuate(stray, { issuerKey: owner.key, subject: staff.key.did, actions: ['pay:receive'], validFrom: NOW.toISOString(), validUntil: iso(NOW.getTime() + 7 * DAY) }), owner.key);
    const bad = await call('POST', `/merchant/enterprises/${enc(enterpriseDid)}/staff`, { session: sessionOf(owner), body: { vac: fromStray } });
    expect(bad.body.code).toBe('BAD_CHAIN');
    const notOwner = await call('POST', `/merchant/enterprises/${enc(enterpriseDid)}/staff`, { session: sessionOf(customer), body: { vac: fromStray } });
    expect(notOwner.body.code).toBe('NOT_OWNER');
  });
});

describe('steward', () => {
  it('computes the re-spend ratio: enterprise earns 100, spends 60 → 0.6', async () => {
    await run(async (ctx) => {
      const s = persona('T2');
      const sess = sessionOf(s);
      const { enterprise } = await createEnterprise(ctx, deps, sess, { credentials: s.creds, name: 'Re-spend Co', categories: ['x'], acceptanceCategory: 'services' });
      const a = generateKeyPair().did;
      const b = generateKeyPair().did;
      await ctx.db.query(`INSERT INTO accounts (did, kind, limit_band, credit_limit) VALUES ($1, 'member', 'L3', 1000), ($2, 'member', 'L3', 1000)`, [a, b]);
      await settle(ctx, { from: a, to: enterprise.did, amount: 100, invoice: 'r1' });
      await settle(ctx, { from: enterprise.did, to: b, amount: 60, invoice: 'r2' });
      expect(await reSpendRatio(ctx)).toEqual({ ratio: 0.6, inflow: 100, outflow: 60 });
      const [{ total }] = await ctx.db.query('SELECT SUM(balance) AS total FROM accounts');
      expect(Number(total)).toBe(0);
    }, NOW, 'respend');
  });

  it('reports kill-criteria statuses', async () => {
    await run(async (ctx) => {
      const mk = async (name: string) => {
        const p = persona('T1');
        return (await createEnterprise(ctx, deps, sessionOf(p), { credentials: p.creds, name, categories: ['x'], acceptanceCategory: 'retail', ceiling: 100 })).enterprise.did;
      };
      const e1 = await mk('One');
      const e2 = await mk('Two');
      await mk('Three');
      const m = generateKeyPair().did;
      await ctx.db.query(`INSERT INTO accounts (did, kind, limit_band, credit_limit) VALUES ($1, 'member', 'L3', 1000)`, [m]);
      await settle(ctx, { from: m, to: e1, amount: 90, invoice: 'k1' });
      await settle(ctx, { from: m, to: e2, amount: 85, invoice: 'k2' });
      await settle(ctx, { from: e1, to: m, amount: 20, invoice: 'k3' }); // re-spend 20/175 ≈ 0.114 → breach
      await ctx.db.query(
        `INSERT INTO offers (id, kind, record) VALUES ('n1', 'need', '{"resourceSpec":"bike repair"}'), ('n2', 'need', '{"resourceSpec":"childcare"}'), ('o1', 'offer', '{"resourceSpec":"bike tune-ups"}')`,
      );
    }, NOW, 'kills');
    const setCounsel = await call('POST', '/steward/flags', { session: stewardSession, slug: 'kills', body: { key: 'counsel', value: { flagged: true, note: 'review transmitter rules' } } });
    expect(setCounsel.status).toBe(200);
    const res = await call('GET', '/steward/exposure', { session: stewardSession, slug: 'kills' });
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.killCriteria.map((k: any) => [k.id, k.status]));
    expect(byId).toEqual({ respend: 'breach', ceilings: 'warn', 'unmet-demand': 'warn', counsel: 'breach' });
    // e1 at 70/100 after re-spend, e2 at 85/100: 1 of 3 above 80% is a warning, not a breach (needs > ⅓).
    expect(res.body.enterprises.find((e: any) => e.name === 'Two')).toMatchObject({ balance: 85, ceiling: 100, pct: 0.85 });
    expect(res.body.volume).toEqual({ count: 3, sum: 195 });

    const broker = await call('GET', '/steward/brokerage', { session: stewardSession, slug: 'kills' });
    expect(broker.body.queue.map((q: any) => q.needId)).toEqual(['n2']);
    await call('POST', '/steward/matches', { session: stewardSession, slug: 'kills', body: { needId: 'n2', offerId: 'o1', note: 'neighbour can babysit' } });
    expect((await call('GET', '/steward/brokerage', { session: stewardSession, slug: 'kills' })).body.queue).toEqual([]);
    expect((await call('GET', '/steward/matches', { session: stewardSession, slug: 'kills' })).body.matches).toHaveLength(1);

    const direct = await run((ctx) => exposure(ctx), NOW, 'kills');
    expect(direct.reSpendRatio).toBeCloseTo(0.114, 3);
  });

  it('breaches the ceilings criterion when more than a third are above 80%', async () => {
    await run(async (ctx) => {
      const e3 = (await ctx.db.query(`SELECT did FROM enterprises WHERE name = 'Three'`))[0].did;
      const m = (await ctx.db.query(`SELECT did FROM accounts WHERE kind = 'member'`))[0].did;
      await settle(ctx, { from: m, to: e3, amount: 95, invoice: 'k4' });
      const ex = await exposure(ctx);
      expect(ex.killCriteria.find((k) => k.id === 'ceilings')!.status).toBe('breach');
    }, NOW, 'kills');
  });

  it('refuses the steward console without pep:review', async () => {
    const res = await call('GET', '/steward/exposure', { session: sessionOf(customer) });
    expect(res.status).toBe(403);
  });

  it('exports a CSV with a header row and one line per settled entry, and 1099-B totals', async () => {
    const res = await call('GET', '/exports/transactions.csv', { session: stewardSession });
    expect(res.headers?.['content-type']).toMatch(/^text\/csv/);
    const lines = (res.body as string).trim().split('\r\n');
    expect(lines[0]).toBe('id,createdAt,payer,payee,amount,unit,invoice,totalSale,tenderStatus');
    const [{ n }] = await run((ctx) => ctx.db.query(`SELECT COUNT(*) AS n FROM ledger_entries WHERE status = 'settled'`));
    expect(lines).toHaveLength(Number(n) + 1);
    expect(lines.some((l) => l.includes(',30,credit,') && l.endsWith(',40 USD,recorded'))).toBe(true);

    const totals = await call('GET', '/exports/1099b.json', { session: stewardSession });
    expect(totals.body.year).toBe(2026);
    expect(totals.body.enterprises.find((e: any) => e.did === enterpriseDid)).toMatchObject({ name: 'Moxie Bread', totalReceived: 39, count: 3 }); // 30 + 6 offline + 3 rung up by staff
  });

  it('files a dispute against a transaction', async () => {
    const [{ id }] = await run((ctx) => ctx.db.query(`SELECT id FROM ledger_entries WHERE status = 'settled' ORDER BY id LIMIT 1`));
    const res = await call('POST', '/disputes', { session: sessionOf(customer), body: { transactionId: String(id), reason: 'Charged twice' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ transactionId: String(id), status: 'open' });
    const [row] = await run((ctx) => ctx.db.query('SELECT * FROM disputes WHERE id = $1', [res.body.id]));
    expect(row.subject_digest).toBe(String(id));
    const stranger = await call('POST', '/disputes', { session: sessionOf(persona('T1')), body: { transactionId: String(id), reason: 'Not mine' } });
    expect(stranger.body.code).toBe('NOT_A_PARTY');
    expect((await call('POST', '/disputes', { session: sessionOf(owner), body: { transactionId: String(id), reason: 'Refund owed' } })).status).toBe(201);
  });
});

describe('smokeTransfer', () => {
  it('transfers 1 credit and leaves balances and rows unchanged', async () => {
    const snapshot = (ctx: GatewayContext) =>
      Promise.all([
        ctx.db.query('SELECT did, balance FROM accounts ORDER BY did'),
        ctx.db.query('SELECT id, status FROM ledger_entries ORDER BY id'),
      ]);
    for (const slug of ['smoke', SLUG]) {
      const before = await run(snapshot, NOW, slug);
      const r = await run((ctx) => smokeTransfer(ctx), NOW, slug);
      expect(r.ok).toBe(true);
      expect(r.detail).toMatch(/-1 \/ \+1/);
      expect(await run(snapshot, NOW, slug)).toEqual(before);
    }
  });
});

describe('pos-adapter routes', () => {
  it('Square connect is not implemented yet', async () => {
    const res = await call('POST', '/square/connect', { session: sessionOf(owner), table: posRoutes });
    expect(res).toEqual({ status: 501, body: { code: 'NOT_IMPLEMENTED', message: 'Square write-back is coming; record tenders manually for now.' } });
  });

  it('records a tender manually and lists pending reconciliation', async () => {
    const pending = await call('GET', '/reconcile/pending', { session: sessionOf(owner), table: posRoutes });
    expect(pending.body.pending.length).toBeGreaterThan(0);
    const id = pending.body.pending[0].transactionId;
    const res = await call('POST', '/tender/record', { session: sessionOf(owner), table: posRoutes, body: { transactionId: id, provider: 'manual', dollars: pending.body.pending[0].dollarsDue } });
    expect(res.status).toBe(200);
    expect(res.body.externalTender).toMatchObject({ provider: 'manual', ref: `manual-${id}`, status: 'recorded' });
    const stranger = await call('POST', '/tender/record', { session: sessionOf(customer), table: posRoutes, body: { transactionId: id, provider: 'manual', dollars: 2 } });
    expect(stranger.body.code).toBe('NOT_MERCHANT');
  });
});

describe('enterprise credit lines (fix round 1)', () => {
  it('opens enterprises with no credit line, so shell enterprises add no borrowing power', async () => {
    const shellOwner = persona('T1');
    await call('POST', '/accounts/open', { session: sessionOf(shellOwner), body: { credentials: shellOwner.creds } });
    const shells: string[] = [];
    for (const name of ['Shell A', 'Shell B', 'Shell C']) {
      const r = await call('POST', '/merchant/enterprises', { session: sessionOf(shellOwner), body: { credentials: shellOwner.creds, name, categories: ['x'], acceptanceCategory: 'services' } });
      expect(r.body.enterprise.account.limit).toBe(0);
      shells.push(r.body.enterprise.did);
    }
    const requests = [];
    for (const shell of shells) {
      const sale = await ringUp(8); // 6 credits to Moxie
      requests.push(sale.body.request);
      const res = await call('POST', '/pay/authorize', { session: sessionOf(shellOwner), body: authorization(shellOwner, sale.body.request, { from: shell }) });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ code: 'OVER_LIMIT', message: 'This payment would take you 6 credits past your limit of 0.' });
    }

    // A steward may grant an explicit enterprise limit, logged with who and why.
    const noAuth = await call('PUT', `/steward/enterprises/${enc(shells[0]!)}/limit`, { session: sessionOf(shellOwner), body: { creditLimit: 10, reason: 'x' } });
    expect(noAuth.status).toBe(403);
    const set = await call('PUT', `/steward/enterprises/${enc(shells[0]!)}/limit`, { session: stewardSession, body: { creditLimit: 10, reason: 'Seed stock for the co-op launch' } });
    expect(set.body.limit).toMatchObject({ creditLimit: 10, reason: 'Seed stock for the co-op launch', by: stewardSession.subject });
    const [flag] = await run((ctx) => ctx.db.query('SELECT value FROM steward_flags WHERE key = $1', [`limit:${shells[0]}`]));
    expect(flag.value).toMatchObject({ creditLimit: 10 });
    const ok = await call('POST', '/pay/authorize', { session: sessionOf(shellOwner), body: authorization(shellOwner, requests[0], { from: shells[0] }) });
    expect(ok.status).toBe(200);
    expect(await balanceOf(shells[0]!)).toBe(-6);
  });
});

describe('root VACs only (fix round 1)', () => {
  const elder = persona('T3');
  const elderRoot = elder.creds[2]!;
  const forward = (to: KeyPair, actions: string[]) =>
    signDocument(attenuate(elderRoot, { issuerKey: elder.key, subject: to.did, actions, validFrom: NOW.toISOString(), validUntil: iso(NOW.getTime() + 10 * DAY) }), elder.key);

  it('does not let a forwarded credit:limit:L3 raise a limit', async () => {
    const junior = persona('T1');
    junior.creds.push(elderRoot, forward(junior.key, ['credit:limit:L3', 'credit:account']));
    const opened = await call('POST', '/accounts/open', { session: { ...sessionOf(junior), authorities: [...tierDefaultActions('T1'), 'credit:limit:L3'] }, body: { credentials: junior.creds } });
    expect(opened.body.account).toMatchObject({ band: 'L1', limit: 100 });
    const sale = await ringUp(8);
    // The verifier may refuse the forwarded credential outright; either way the limit must not move.
    await call('POST', '/pay/authorize', { session: sessionOf(junior), body: authorization(junior, sale.body.request) });
    const [acct] = await run((ctx) => ctx.db.query('SELECT limit_band, credit_limit FROM accounts WHERE did = $1', [junior.key.did]));
    expect(acct).toMatchObject({ limit_band: 'L1' });
    expect(Number(acct.credit_limit)).toBe(100);
  });

  it('does not let a forwarded credit:account open an account or an enterprise', async () => {
    const outsider = persona('T1');
    const creds = [outsider.creds[0]!, outsider.creds[1]!, elderRoot, forward(outsider.key, ['credit:account'])];
    const session: SessionClaims = { subject: outsider.key.did, pod: POD_DID, tier: 'T0', authorities: ['credit:account'] };
    const res = await call('POST', '/accounts/open', { session, body: { credentials: creds } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MISSING_AUTHORITY');
    const ent = await call('POST', '/merchant/enterprises', { session: { ...session, tier: 'T1' }, body: { credentials: creds, name: 'Nope', categories: ['x'], acceptanceCategory: 'retail' } });
    expect(ent.body.code).toBe('MISSING_AUTHORITY');
    // A root VAC with a forged pod signature does not count either.
    const forged = signDocument(buildAuthority({ issuer: POD_DID, subject: outsider.key.did, scope: POD_DID, actions: ['credit:account'], validFrom: NOW.toISOString(), validUntil: iso(NOW.getTime() + 10 * DAY) }), outsider.key);
    expect((await call('POST', '/accounts/open', { session, body: { credentials: [forged] } })).body.code).toBe('MISSING_AUTHORITY');
  });
});

describe('kill criteria and exports (fix round 1)', () => {
  it('unmet demand compares unmatched needs with matches and can breach', async () => {
    expect(unmetDemandStatus(0, 0)).toBe('ok');
    expect(unmetDemandStatus(1, 1)).toBe('ok');
    expect(unmetDemandStatus(3, 1)).toBe('warn');
    expect(unmetDemandStatus(4, 0)).toBe('warn');
    expect(unmetDemandStatus(5, 2)).toBe('breach');
    expect(unmetDemandStatus(5, 3)).toBe('warn');
    await run(
      (ctx) =>
        ctx.db.query(
          `INSERT INTO offers (id, kind, record) VALUES
             ('n3','need','{"resourceSpec":"plumbing"}'), ('n4','need','{"resourceSpec":"roofing"}'), ('n5','need','{"resourceSpec":"tutoring"}'),
             ('n6','need','{"resourceSpec":"firewood"}'), ('n7','need','{"resourceSpec":"sewing"}')`,
        ),
      NOW,
      'kills',
    );
    const res = await call('GET', '/steward/exposure', { session: stewardSession, slug: 'kills' });
    const unmet = res.body.killCriteria.find((k: any) => k.id === 'unmet-demand');
    expect(unmet.status).toBe('breach');
    expect(unmet.detail).toMatch(/^5 needs have no matching offer against 1 logged matches/);
  });

  it('guards CSV cells against formula injection and quotes them', async () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    const sale = await ringUp(8, { invoice: '=HYPERLINK("x")' });
    expect((await call('POST', '/pay/authorize', { session: sessionOf(customer), body: authorization(customer, sale.body.request) })).status).toBe(200);
    const csv = (await call('GET', '/exports/transactions.csv', { session: stewardSession })).body as string;
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });

  it('stores W-9 status privately on the enterprise', async () => {
    const res = await call('PUT', `/merchant/enterprises/${enc(enterpriseDid)}/rules`, { session: sessionOf(owner), body: { w9: { onFile: true, capturedAt: '2026-09-01' } } });
    expect(res.body.w9).toEqual({ onFile: true, capturedAt: '2026-09-01T00:00:00.000Z' });
    await call('PUT', `/merchant/enterprises/${enc(enterpriseDid)}/rules`, { session: sessionOf(owner), body: { maxShare: 0.7 } });
    const mine = await call('GET', '/merchant/enterprises/mine', { session: sessionOf(owner) });
    expect(mine.body.enterprises.find((e: any) => e.did === enterpriseDid).w9).toEqual({ onFile: true, capturedAt: '2026-09-01T00:00:00.000Z' });
    const [rec] = await run((ctx) => ctx.db.query(`SELECT record FROM records WHERE collection = 'enterprise' AND record->>'did' = $1`, [enterpriseDid]));
    expect(rec.record.w9).toBeUndefined();
    expect(rec.record.acceptanceShare).toBe(0.7);
    expect((await call('PUT', `/merchant/enterprises/${enc(enterpriseDid)}/rules`, { session: sessionOf(owner), body: { w9: { onFile: 'yes' } } })).body.code).toBe('BAD_REQUEST');
  });
});
