import 'fake-indexeddb/auto';
import { createResolver, digestMultibase, isMembershipPairComplete, randomNonce, verifyDocument } from '@passport/credential-core';
import { PayAuthorizationMessageSchema } from '@passport/lexicons';
import { boulderManifest } from '@passport/tenant-config';
import { tierDefaultActions } from '@passport/vocab';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ceremony } from './ceremony.js';
import { PodClient } from './client.js';
import { acceptMembership, applyForMembership, optInToIndex, refreshTier, signIn } from './membership.js';
import { buildPayAuthorization } from './pay.js';
import { PodError } from './util.js';
import { createWallet, type Wallet } from './wallet.js';
import { bootstrapConvener, createHarness, POD_DID, SLUG, type Harness } from './test/harness.js';

let h: Harness;
const wallets: Wallet[] = [];

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  for (const w of wallets) await w.forget();
  await h.close();
});

/** A simulated phone: its own IndexedDB wallet and its own cookie jar against the in-process pod. */
async function phone() {
  const wallet = await createWallet({ name: `srv-${randomNonce(6)}` });
  wallets.push(wallet);
  const persona = await wallet.mintPersona(SLUG);
  await wallet.addPod(boulderManifest, persona.did);
  const fetch = h.fetchFor();
  const client = new PodClient({ slug: SLUG, manifest: boulderManifest, baseUrl: '', fetch, persona, db: wallet.db });
  return { wallet, persona, client, jar: fetch.jar, ceremony: new Ceremony({ wallet, relay: client.relay(), pod: SLUG }) };
}

describe('wallet payloads against the real pod VTA', () => {
  it('visitor session, ceremony over the HTTP relay, witness, apply, consent, VACs, member session', async () => {
    const alice = await phone(); // the newcomer
    const bob = await phone(); // a neighbor she meets
    const carol = await phone(); // the convener

    // F1: a visitor session is holder-only.
    const visitor = await alice.client.visitorSession();
    expect(visitor).toMatchObject({ subject: alice.persona.did, tier: 'T0', authorities: [] });
    expect(alice.jar.session?.pod).toBe('');

    // The operator bootstraps Carol as the first steward; her wallet holds the VAC. (A bootstrapped steward has no
    // membership pair, so the jar carries her T3 claims directly, as pod-vta's own tests do.)
    const boot = await bootstrapConvener(h, carol.persona.did);
    await carol.wallet.replaceVacs(SLUG, boot.vacs);
    expect(await carol.wallet.authorities(SLUG)).toContain('vwc:issue');
    carol.jar.session = { subject: carol.persona.did, pod: POD_DID, tier: 'T3', authorities: tierDefaultActions('T3') };
    const now = Date.now();
    const event = await carol.client.createEvent({ title: 'Creek cleanup', startsAt: new Date(now - 30 * 60_000).toISOString(), endsAt: new Date(now + 3 * 3600_000).toISOString() });
    expect(event.attestation).toBe(true);
    const listed = await alice.client.events();
    expect(listed.map((e) => e.id)).toContain(event.id);
    const ev = listed.find((e) => e.id === event.id)!;

    // F2 front half over the real relay routes.
    const session = await bob.ceremony.host({ event: ev.id });
    const joined = await alice.ceremony.join(session.inviteJson);
    expect(joined.queued).toBeFalsy();
    const bobMet = await bob.ceremony.pollHost(session);
    const aliceMet = await alice.ceremony.pollJoin(joined);
    expect(aliceMet!.edgeDigest).toBe(bobMet!.edgeDigest);

    // "I'm here": witness request on the event channel; Carol witnesses; Alice picks up the result.
    await alice.ceremony.requestWitness(ev, bob.persona.did);
    const requests = await carol.ceremony.listWitnessRequests(ev);
    expect(requests).toHaveLength(1);
    const vwc = await carol.ceremony.witness(carol.client, ev, requests[0]!);
    expect(vwc).toMatchObject({ issuer: POD_DID, credentialSubject: { predicate: 'dtg:witnessed', witnessedBy: carol.persona.did, object: { digestMultibase: aliceMet!.edgeDigest } } });
    expect(await carol.ceremony.listWitnessRequests(ev)).toHaveLength(0);
    const again = await carol.client.witness(ev.id, requests[0]!.vrcA, requests[0]!.vrcB).catch((e) => e);
    expect(again).toMatchObject({ status: 409, code: 'ALREADY_WITNESSED', message: 'This relationship has already been witnessed in this pod.' });
    expect(await alice.ceremony.pollWitnessResult(ev, bob.persona.did)).toMatchObject({ issuer: POD_DID });

    // A non-convener cannot witness: the server's one-sentence gate comes back as a PodError.
    const err = await bob.client.witness(ev.id, aliceMet!.vrcOut, aliceMet!.vrcIn).catch((e) => e);
    expect(err).toBeInstanceOf(PodError);
    expect(err.status).toBe(401);
    expect(err.message).toBe('You need to present your passport before doing this.');

    // Apply → grant (not yet a member) → consent → ack → T1 VACs.
    const grant = await applyForMembership(alice.wallet, alice.client, bob.persona.did);
    expect(grant).toMatchObject({ issuer: POD_DID, credentialSubject: { id: alice.persona.did, bioregion: SLUG, governance: boulderManifest.governance.url } });
    expect(await alice.wallet.membership(SLUG)).toBeUndefined();
    const accepted = await acceptMembership(alice.wallet, alice.client, grant);
    expect(accepted.member).toMatchObject({ did: alice.persona.did, tier: 'T1' });
    expect([...(accepted.vacs[0]!.credentialSubject['authority'].actions as string[])].sort()).toEqual([...tierDefaultActions('T1')].sort());
    expect(accepted.explanation).toContain('Your membership pair is complete.');
    const pair = await alice.wallet.membership(SLUG);
    expect(pair && isMembershipPairComplete(pair.grant, pair.ack).ok).toBe(true);
    expect(pair!.ack.credentialSubject['digestMultibase']).toBe(digestMultibase(grant));
    expect(accepted.session).toMatchObject({ subject: alice.persona.did, tier: 'T1' });
    expect(alice.jar.session).toMatchObject({ subject: alice.persona.did, pod: POD_DID, tier: 'T1' });
    expect((await alice.wallet.pod(SLUG))!.tier).toBe('T1');

    // Presentations for requirements; member session with a required authority.
    const vp = await alice.wallet.presentTo(SLUG, ['MembershipCredential:pod', 'AuthorityCredential:credit:account'], { challenge: 'c-1' });
    expect(vp.verifiableCredential).toHaveLength(3);
    expect(vp.proof).toMatchObject({ proofPurpose: 'authentication', challenge: 'c-1', domain: `${SLUG}.bioregionalpassport.org` });
    const s = await signIn(alice.wallet, alice.client, ['credit:account']);
    expect(s).toMatchObject({ visitor: false, tier: 'T1' });
    const refused = await alice.client.session(await alice.wallet.selectFor(SLUG), ['vwc:issue']).catch((e) => e);
    expect(refused).toMatchObject({ status: 403, code: 'MISSING_AUTHORITY' });
    expect(refused.message.length).toBeGreaterThan(10);

    // Opt in: the witnessed relationship counts toward the trust index.
    const c = await optInToIndex(alice.wallet, alice.client, bob.persona.did, 'relationship');
    expect(c.accepted).toBe(1);

    // "Why this tier": refresh explains and names what would change it.
    const r = await refreshTier(alice.wallet, alice.client);
    expect(r.tier).toBe('T1');
    expect(r.explanation.length).toBeGreaterThan(0);
    expect(r.next?.tier).toBe('T2');
    expect(r.next!.missing.length).toBeGreaterThan(0);
    expect(r.next!.hints.every((x) => /[.]$/.test(x))).toBe(true);
    expect((await alice.wallet.pod(SLUG))!.lastExplanation).toMatchObject({ tier: 'T1' });

    // Pay: the authorization the gateway expects (B3 §6), bound to the invoice and signed by the persona.
    const request = {
      type: 'org.bioregion.pay.request' as const,
      merchant: 'did:web:bioregionalpassport.org:dids:boulder:e:moxie',
      pod: POD_DID,
      node: boulderManifest.currency.node,
      amount: { unit: 'credit', value: 5 },
      totalSale: { unit: 'USD', value: 20 },
      invoice: 'inv_test_1',
      expires: new Date(Date.now() + 600_000).toISOString(),
      acceptance: { maxShare: 0.25, requires: ['MembershipCredential:pod', 'AuthorityCredential:credit:account'] },
    };
    const auth = buildPayAuthorization(alice.persona, request, await alice.wallet.selectFor(SLUG, request.acceptance.requires), `${SLUG}.bioregionalpassport.org`);
    expect(PayAuthorizationMessageSchema.safeParse(auth).success).toBe(true);
    expect(auth.presentation.proof).toMatchObject({ challenge: 'inv_test_1', domain: `${SLUG}.bioregionalpassport.org` });
    expect(auth.transfer).toMatchObject({ from: alice.persona.did, to: request.merchant, amount: request.amount, invoice: request.invoice });
    const { sig, ...signed } = auth;
    expect(sig).toBe(auth.proof.proofValue);
    expect((await verifyDocument(signed, createResolver())).ok).toBe(true);

    // Bob, the other party, can be admitted with the same witness credential (at most the two parties).
    await bob.ceremony.pollWitnessResult(ev, alice.persona.did);
    const bobGrant = await applyForMembership(bob.wallet, bob.client, alice.persona.did);
    expect(bobGrant.credentialSubject.id).toBe(bob.persona.did);
  });

  it('refuses an application whose relationship halves do not match the witness credential', async () => {
    const dave = await phone();
    const erin = await phone();
    const frank = await phone();
    const carol = await phone();
    await bootstrapConvener(h, carol.persona.did);
    carol.jar.session = { subject: carol.persona.did, pod: POD_DID, tier: 'T3', authorities: tierDefaultActions('T3') };
    const now = Date.now();
    const ev = await carol.client.createEvent({ title: 'Seed swap', startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 3600_000).toISOString() });
    const s1 = await erin.ceremony.host();
    const j1 = await dave.ceremony.join(s1.inviteJson);
    await erin.ceremony.pollHost(s1);
    await dave.ceremony.pollJoin(j1);
    const s2 = await frank.ceremony.host();
    const j2 = await dave.ceremony.join(s2.inviteJson);
    const met2 = await frank.ceremony.pollHost(s2);
    await dave.ceremony.pollJoin(j2);
    await dave.ceremony.requestWitness(ev, erin.persona.did);
    const [req] = await carol.ceremony.listWitnessRequests(ev);
    const vwc = await carol.ceremony.witness(carol.client, ev, req!);
    // Dave presents the Frank pair with the Erin witness credential.
    const err = await dave.client.apply(vwc, met2!.vrcIn, met2!.vrcOut).catch((e) => e);
    expect(err).toMatchObject({ status: 403, code: 'EDGE_NOT_YOURS' });
    expect(err.message).toBe('This witness credential is for a relationship you are not part of.');
  });
});
