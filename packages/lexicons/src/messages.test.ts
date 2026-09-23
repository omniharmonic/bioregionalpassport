import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { PayRequestMessageSchema, parseMessage } from './messages.js';

const createdAt = '2026-09-22T12:00:00Z';

describe('parseMessage — ceremony messages (B3 §5)', () => {
  it('round-trips org.bioregion.oob.invite', () => {
    const msg = {
      type: 'org.bioregion.oob.invite',
      createdAt,
      seq: 1,
      pairwiseDid: 'did:key:z6Mkpairwise',
      challenge: 'nonce-abc',
      pod: 'boulder',
      event: 'evt-1',
    };
    expect(parseMessage(msg)).toEqual(msg);
  });

  it('round-trips org.bioregion.vrc.offer and .accept', () => {
    const offer = {
      type: 'org.bioregion.vrc.offer',
      createdAt,
      seq: 2,
      vrc: { half: 'a' },
      vec: { scope: 'knows' },
    };
    expect(parseMessage(offer)).toEqual(offer);

    const accept = {
      type: 'org.bioregion.vrc.accept',
      createdAt,
      seq: 3,
      vrc: { half: 'b' },
    };
    expect(parseMessage(accept)).toEqual(accept);
  });

  it('round-trips org.bioregion.witness.request and .result', () => {
    const request = {
      type: 'org.bioregion.witness.request',
      createdAt,
      seq: 4,
      edgeDigest: 'zEdgeDigest',
      taskContext: 'evt-1',
      requester: 'did:key:z6Mkmember',
    };
    expect(parseMessage(request)).toEqual(request);

    const result = {
      type: 'org.bioregion.witness.result',
      createdAt,
      seq: 5,
      vwc: { credential: 'stub' },
    };
    expect(parseMessage(result)).toEqual(result);
  });

  it('round-trips org.bioregion.event.attestation', () => {
    const msg = {
      type: 'org.bioregion.event.attestation',
      createdAt,
      seq: 6,
      id: 'evt-1',
      pod: 'boulder',
      startsAt: '2026-10-01T18:00:00Z',
      endsAt: '2026-10-01T20:00:00Z',
      conveners: ['did:key:z6Mkconvener'],
      location: { placeId: 'huc12-1', lat: 40.01, lon: -105.27, name: 'Commons Park' },
    };
    expect(parseMessage(msg)).toEqual(msg);
  });

  it('round-trips org.bioregion.membership.apply / .grant / .ack', () => {
    const apply = {
      type: 'org.bioregion.membership.apply',
      createdAt,
      seq: 7,
      vwc: { credential: 'stub' },
      presentation: { holder: 'did:key:z6Mkmember' },
    };
    expect(parseMessage(apply)).toEqual(apply);

    const grant = {
      type: 'org.bioregion.membership.grant',
      createdAt,
      seq: 8,
      grant: { credential: 'stub' },
    };
    expect(parseMessage(grant)).toEqual(grant);

    const ack = {
      type: 'org.bioregion.membership.ack',
      createdAt,
      seq: 9,
      ack: { credential: 'stub' },
    };
    expect(parseMessage(ack)).toEqual(ack);
  });

  it('round-trips org.bioregion.authority.issue and .revoke', () => {
    const issue = {
      type: 'org.bioregion.authority.issue',
      createdAt,
      seq: 10,
      vacs: [{ credential: 'stub' }],
      explanation: ['3 of 3 witnessed edges'],
    };
    expect(parseMessage(issue)).toEqual(issue);

    const revoke = {
      type: 'org.bioregion.authority.revoke',
      createdAt,
      seq: 11,
      digest: 'zDigest',
      reason: 'compromised key',
    };
    expect(parseMessage(revoke)).toEqual(revoke);
  });

  it('round-trips org.bioregion.index.commit', () => {
    const msg = {
      type: 'org.bioregion.index.commit',
      createdAt,
      seq: 12,
      commitments: [{ commitment: 'zCommit1', scope: 'lives-here', witnessRef: 'zWitness1' }],
    };
    expect(parseMessage(msg)).toEqual(msg);
  });

  it('round-trips org.bioregion.recovery.share and .request', () => {
    const share = {
      type: 'org.bioregion.recovery.share',
      createdAt,
      seq: 13,
      share: { ciphertext: 'zShare1' },
    };
    expect(parseMessage(share)).toEqual(share);

    const request = {
      type: 'org.bioregion.recovery.request',
      createdAt,
      seq: 14,
      requester: 'did:key:z6Mkrequester',
    };
    expect(parseMessage(request)).toEqual(request);
  });

  it('throws a ZodError on an unknown message type', () => {
    expect(() => parseMessage({ type: 'org.bioregion.nonsense', createdAt, seq: 1 })).toThrow(
      ZodError,
    );
  });

  it('throws a ZodError when createdAt/seq are missing', () => {
    expect(() =>
      parseMessage({
        type: 'org.bioregion.recovery.request',
        requester: 'did:key:z6Mkrequester',
      }),
    ).toThrow(ZodError);
  });
});

describe('payment protocol messages (B3 §6)', () => {
  const validRequest = {
    type: 'org.bioregion.pay.request',
    merchant: 'did:web:bioregionalpassport.org:enterprises:fixit',
    pod: 'boulder',
    node: 'https://node.boulder.bioregionalpassport.org',
    amount: { unit: 'credit', value: 12 },
    totalSale: { unit: 'USD', value: 40 },
    invoice: 'inv-001',
    expires: '2026-09-22T12:10:00Z',
    acceptance: {
      maxShare: 0.35,
      requires: ['MembershipCredential:pod', 'AuthorityCredential:credit:account'],
    },
  };

  it('round-trips org.bioregion.pay.request', () => {
    expect(parseMessage(validRequest)).toEqual(validRequest);
  });

  it('rejects a PayRequest with maxShare > 1', () => {
    const invalid = {
      ...validRequest,
      acceptance: { ...validRequest.acceptance, maxShare: 1.2 },
    };
    expect(PayRequestMessageSchema.safeParse(invalid).success).toBe(false);
    expect(() => parseMessage(invalid)).toThrow(ZodError);
  });

  it('rejects a PayRequest missing invoice', () => {
    const { invoice, ...withoutInvoice } = validRequest;
    expect(PayRequestMessageSchema.safeParse(withoutInvoice).success).toBe(false);
    expect(() => parseMessage(withoutInvoice)).toThrow(ZodError);
  });

  it('round-trips org.bioregion.pay.authorization', () => {
    const msg = {
      type: 'org.bioregion.pay.authorization',
      request: validRequest,
      payer: 'did:key:z6Mkpayer',
      transfer: {
        from: 'did:key:z6Mkpayer',
        to: 'did:web:bioregionalpassport.org:enterprises:fixit',
        amount: { unit: 'credit', value: 12 },
        invoice: 'inv-001',
        createdAt,
      },
      presentation: { holder: 'did:key:z6Mkpayer' },
    };
    expect(parseMessage(msg)).toEqual(msg);
  });

  it('round-trips org.bioregion.pay.receipt', () => {
    const msg = {
      type: 'org.bioregion.pay.receipt',
      transactionId: 'txn-001',
      invoice: 'inv-001',
      amount: { unit: 'credit', value: 12 },
      totalSale: { unit: 'USD', value: 40 },
      payer: 'did:key:z6Mkpayer',
      payee: 'did:web:bioregionalpassport.org:enterprises:fixit',
      createdAt,
      posWriteBack: { status: 'recorded', provider: 'manual', ref: 'r-1' },
    };
    expect(parseMessage(msg)).toEqual(msg);
  });

  it('rejects a receipt with an invalid posWriteBack status', () => {
    const invalid = {
      type: 'org.bioregion.pay.receipt',
      transactionId: 'txn-001',
      invoice: 'inv-001',
      amount: { unit: 'credit', value: 12 },
      totalSale: { unit: 'USD', value: 40 },
      payer: 'did:key:z6Mkpayer',
      payee: 'did:web:bioregionalpassport.org:enterprises:fixit',
      createdAt,
      posWriteBack: { status: 'done' },
    };
    expect(() => parseMessage(invalid)).toThrow(ZodError);
  });
});
