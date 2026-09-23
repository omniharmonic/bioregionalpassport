import { createPresentation, signDocument, type KeyPair, type VerifiableCredential } from '@passport/credential-core';
import { PayRequestMessageSchema, type PayRequestMessage } from '@passport/lexicons';
import type { PodClient } from './client.js';
import { withSession } from './membership.js';
import { podDomainOf } from './util.js';
import type { Wallet } from './wallet.js';

/** Parses a scanned payment request QR (`org.bioregion.pay.request`). */
export function parsePaymentRequest(text: string): PayRequestMessage & Record<string, any> {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    throw new Error('That code is not a payment request.');
  }
  const r = PayRequestMessageSchema.safeParse(raw);
  if (!r.success) throw new Error('That code is not a payment request.');
  return raw as PayRequestMessage & Record<string, any>;
}

/**
 * `org.bioregion.pay.authorization` (B3 §6): the transfer `{from, to, amount, invoice, createdAt}` plus a
 * presentation (membership pair + `credit:account` VAC) bound to challenge = invoice and domain = pod domain,
 * all signed by the persona; `sig` mirrors the proof value.
 */
export function buildPayAuthorization(persona: KeyPair, request: PayRequestMessage & Record<string, any>, creds: VerifiableCredential[], domain: string, now: Date = new Date()) {
  const presentation = createPresentation(creds, persona, { challenge: request.invoice, domain });
  const unsigned = {
    type: 'org.bioregion.pay.authorization' as const,
    request,
    payer: persona.did,
    transfer: { from: persona.did, to: request.merchant, amount: request.amount, invoice: request.invoice, createdAt: now.toISOString() },
    presentation,
  };
  const signed = signDocument(unsigned, persona);
  return { ...signed, sig: signed.proof.proofValue };
}

/** Signs and submits a payment for `request` in the client's pod (`POST /api/gateway/pay/authorize`). */
export async function payRequest(wallet: Wallet, client: PodClient, request: PayRequestMessage & Record<string, any>): Promise<{ receipt: any; balance?: number }> {
  const pod = await wallet.pod(client.slug);
  const persona = await wallet.personaFor(client.slug);
  if (!pod || !persona) throw new Error('Join this pod in your passport first.');
  if (request.pod !== pod.did) throw new Error('This payment request is for a different pod.');
  if (Date.parse(request.expires) <= wallet.now().getTime()) throw new Error('This payment request has expired; ask the merchant to ring it up again.');
  const creds = await wallet.selectFor(client.slug, request.acceptance.requires);
  const authorization = buildPayAuthorization(persona, request, creds, podDomainOf(client.slug, pod.did), wallet.now());
  return withSession(wallet, client, () => client.payAuthorize(authorization));
}
