import { errorResult, ServiceError } from '@passport/service-kit';
import { describe, expect, it } from 'vitest';
import { manualAdapter } from './adapter.js';
import { createPosAdapterRoutes } from './routes.js';
import { parseTender, sealMessage } from './tender.js';

describe('manual adapter', () => {
  it('records a tender by its POS reference, else by transaction id', async () => {
    const entry = { id: '7', invoice: 'inv_1', amount: 30, unit: 'credit', payee: 'did:key:z1' };
    expect(await manualAdapter.recordTender(entry, { provider: 'square', ref: ' sq_9 ', dollars: 10 })).toEqual({ ref: 'sq_9', status: 'recorded' });
    expect(await manualAdapter.recordTender(entry, { provider: 'manual', dollars: 10 })).toEqual({ ref: 'manual-7', status: 'recorded' });
  });

  it('validates tenders with one-sentence errors', () => {
    expect(parseTender({ provider: 'clover', dollars: 12.345 })).toEqual({ provider: 'clover', dollars: 12.35 });
    expect(() => parseTender({ provider: 'venmo', dollars: 1 })).toThrow(/provider must be one of manual, square, clover, shopify/);
    expect(() => parseTender({ provider: 'manual', dollars: -1 })).toThrow(ServiceError);
  });

  it('seals a message with a proof and mirrors proofValue into sig, replacing an old seal', () => {
    const signer = { did: 'did:x', kid: 'did:x#k', sign: <T extends object>(d: T) => ({ ...d, proof: { proofValue: `z${JSON.stringify(d).length}` } }) };
    const once = sealMessage(signer, { a: 1 });
    expect(once.sig).toBe(once.proof.proofValue);
    const twice = sealMessage(signer, { ...once, a: 2 });
    expect(twice.sig).toBe(once.sig); // same unsigned length: the old proof/sig were stripped before signing
  });
});

describe('routes', () => {
  it('Square connect answers 501 with a sentence', async () => {
    const route = createPosAdapterRoutes().find((r) => r.path === '/square/connect')!;
    const out = await route.handler({} as any, { params: {}, query: {}, body: {} }).catch(errorResult);
    expect(out).toEqual({ status: 501, body: { code: 'NOT_IMPLEMENTED', message: 'Square write-back is coming; record tenders manually for now.' } });
  });
});
