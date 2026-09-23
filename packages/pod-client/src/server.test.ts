import 'fake-indexeddb/auto';
import { buildAuthority, createResolver, digestMultibase, isMembershipPairComplete, randomNonce, verifyDocument } from '@passport/credential-core';
import { PayAuthorizationMessageSchema } from '@passport/lexicons';
import { boulderManifest } from '@passport/tenant-config';
import { tierDefaultActions } from '@passport/vocab';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ceremony } from './ceremony.js';
import { PodClient } from './client.js';
import { acceptMembership, addPodCredential, applyForMembership, optInToIndex, refreshTier, renewSession, signIn } from './membership.js';
import { buildPayAuthorization } from './pay.js';
import { PodError } from './util.js';
import { createWallet, type Wallet } from './wallet.js';
import { bootstrapConvener, createHarness, POD_DID, SLUG, type Harness } from './test/harness.js';
import { statusListUrl } from '@passport/pod-vta';
import type { SessionClaims } from '@passport/service-kit';

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
  return { wallet, persona, client, jar: fetch.jar, ceremony: new Ceremony({ wallet, relay: client.relay(), pod: SLUG, resolver: h.deps.resolver }) };
}

/** A root `pay:receive` VAC for an enterprise owner, logged in `vac_issuance_log` exactly as cc-gateway does. */
async function ownerPayVac(owner: string, enterprise: string) {
  return h.run(async (ctx) => {
    const validFrom = new Date().toISOString();
    const validUntil = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const [log] = await ctx.db.query<{ id: string | number }>(
      `INSERT INTO vac_issuance_log (subject_did, actions, tier, policy_version, explanation, issued_at, valid_until)
       VALUES ($1, $2::jsonb, 'T1', 1, '[]'::jsonb, $3, $4) RETURNING id`,
      [owner, JSON.stringify(['pay:receive']), validFrom, validUntil],
    );
    const id = String(log!.id);
    const unsigned = buildAuthority({ issuer: POD_DID, subject: owner, scope: enterprise, actions: ['pay:receive'], validFrom, validUntil, tier: 'T1' });
    unsigned.credentialStatus = { id: `${statusListUrl(ctx)}#${id}`, type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: id, statusListCredential: statusListUrl(ctx) };
    const vac = h.deps.podSigner.sign(unsigned, { created: validFrom });
    await ctx.db.query('UPDATE vac_issuance_log SET credential = $2::jsonb WHERE id = $1', [id, JSON.stringify(vac)]);
    return vac;
  });
}

/** Alice met Bob at Carol's event, was witnessed, applied and accepted: a T1 member with a member session. */
async function admittedMember() {
  const alice = await phone();
  const bob = await phone();
  const carol = await phone();
  await bootstrapConvener(h, carol.persona.did);
  carol.jar.session = { subject: carol.persona.did, pod: POD_DID, tier: 'T3', authorities: tierDefaultActions('T3') };
  const now = Date.now();
  const ev = await carol.client.createEvent({ title: 'Potluck', startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 3600_000).toISOString() });
  const s = await bob.ceremony.host();
  const j = await alice.ceremony.join(s.inviteJson);
  await bob.ceremony.pollHost(s);
  await alice.ceremony.pollJoin(j);
  await alice.ceremony.requestWitness(ev, bob.persona.did);
  const [req] = await carol.ceremony.listWitnessRequests(ev);
  await carol.ceremony.witness(carol.client, ev, req!);
  await alice.ceremony.pollWitnessResult(ev, bob.persona.did);
  const grant = await applyForMembership(alice.wallet, alice.client, bob.persona.did);
  await acceptMembership(alice.wallet, alice.client, grant, { resolver: h.deps.resolver });
  return { alice, bob, carol };
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
    // Re-witnessing (e.g. after a lost response) gives the convener the stored VWC back, never a second edge.
    const again = await carol.client.witness(ev.id, requests[0]!.vrcA, requests[0]!.vrcB);
    expect(digestMultibase(again)).toBe(digestMultibase(vwc));
    expect(await alice.ceremony.pollWitnessResult(ev, bob.persona.did)).toMatchObject({ issuer: POD_DID });

    // A non-convener cannot witness: the server's one-sentence gate comes back as a PodError.
    const err = await bob.client.witness(ev.id, aliceMet!.vrcOut, aliceMet!.vrcIn).catch((e) => e);
    expect(err).toBeInstanceOf(PodError);
    expect(err.status).toBe(401);
    expect(err.message).toBe('You need to present your passport before doing this.');

    // A witness credential the pod refuses is dropped and never picked up again; polling resumes.
    const good = (await alice.wallet.contact(bob.persona.did))!.vwc!;
    const tampered = { ...good, credentialSubject: { ...good.credentialSubject, evidence: 'liveness' } };
    await alice.wallet.updateContact(bob.persona.did, { vwc: tampered });
    await expect(applyForMembership(alice.wallet, alice.client, bob.persona.did)).rejects.toMatchObject({ code: 'WITNESS_INVALID' });
    const afterRefusal = await alice.wallet.contact(bob.persona.did);
    expect(afterRefusal!.vwc).toBeUndefined();
    expect(afterRefusal!.refusedVwcs).toEqual([digestMultibase(tampered)]);
    expect(await alice.ceremony.pollWitnessResult(ev, bob.persona.did)).toMatchObject({ issuer: POD_DID });

    // Apply → grant (not yet a member) → consent → ack → T1 VACs.
    const grant = await applyForMembership(alice.wallet, alice.client, bob.persona.did);
    expect(grant).toMatchObject({ issuer: POD_DID, credentialSubject: { id: alice.persona.did, bioregion: SLUG, governance: boulderManifest.governance.url } });
    expect(await alice.wallet.membership(SLUG)).toBeUndefined();
    const forged = { ...grant, validUntil: new Date(Date.now() + 80 * 86_400_000).toISOString() };
    await expect(acceptMembership(alice.wallet, alice.client, forged, { resolver: h.deps.resolver })).rejects.toThrow('This membership offer is not signed by Boulder Commons.');
    await expect(acceptMembership(bob.wallet, bob.client, grant, { resolver: h.deps.resolver })).rejects.toThrow('was made out to a different identifier');
    const accepted = await acceptMembership(alice.wallet, alice.client, grant, { resolver: h.deps.resolver });
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
    // A retry re-posts the same (deterministically salted) commitment: counted once.
    const retry = await optInToIndex(alice.wallet, alice.client, bob.persona.did, 'relationship');
    expect(retry).toEqual({ accepted: 0, duplicates: 1 });
    expect((await alice.wallet.contact(bob.persona.did))!.committed).toHaveLength(1);

    // "Why this tier": refresh explains and names what would change it.
    const r = await refreshTier(alice.wallet, alice.client);
    expect(r.tier).toBe('T1');
    expect(r.explanation.length).toBeGreaterThan(0);
    expect(r.next?.tier).toBe('T2');
    expect(r.next!.missing.length).toBeGreaterThan(0);
    expect(r.next!.hints.every((x) => /[.]$/.test(x))).toBe(true);
    expect((await alice.wallet.pod(SLUG))!.lastExplanation).toMatchObject({ tier: 'T1' });
    expect(r.session).toMatchObject({ subject: alice.persona.did, tier: 'T1' });

    // A permission handed over later (here the root `pay:receive` VAC for an enterprise Alice registered, logged in
    // `vac_issuance_log` as cc-gateway's merchant registration does) re-opens the session at once, so the cookie
    // carries it without waiting for a refused call (issue 6 of the MVP e2e report).
    const enterprise = 'did:key:z6MkenterpriseForSessionRenewalTest';
    const payVac = await ownerPayVac(alice.persona.did, enterprise);
    expect(alice.jar.session!.authorities).not.toContain(`pay:receive@${enterprise}`);
    const added = await addPodCredential(alice.wallet, alice.client, payVac);
    expect(added.error).toBeUndefined();
    expect(added.session).toMatchObject({ subject: alice.persona.did, tier: 'T1' });
    expect(alice.jar.session!.authorities).toContain(`pay:receive@${enterprise}`);
    // Refreshing the tier: the refresh answer lists every valid logged VAC, so the enterprise permission stays and
    // the renewed session still carries it.
    await refreshTier(alice.wallet, alice.client);
    expect(await alice.wallet.authorities(SLUG)).toContain('pay:receive');
    expect(alice.jar.session!.authorities).toContain(`pay:receive@${enterprise}`);
    // "Refresh my session" after the cookie was lost.
    delete alice.jar.session;
    const renewed = await renewSession(alice.wallet, alice.client);
    expect(renewed).toMatchObject({ visitor: false, tier: 'T1' });
    expect(alice.jar.session!.authorities).toContain(`pay:receive@${enterprise}`);

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

  it('a revoked root pay:receive VAC is superseded at the next refresh and no longer reported', async () => {
    const { alice } = await admittedMember();
    const enterprise = 'did:key:z6MkenterpriseRevokedAtRefresh';
    const payVac = await ownerPayVac(alice.persona.did, enterprise);
    await addPodCredential(alice.wallet, alice.client, payVac);
    await refreshTier(alice.wallet, alice.client);
    expect(await alice.wallet.authorities(SLUG)).toContain('pay:receive');
    // An attenuated staff VAC (authority.parent set) is never in the refresh answer; it must survive refreshes.
    const staff = await alice.wallet.storeCredential(
      h.deps.podSigner.sign(
        buildAuthority({ issuer: POD_DID, subject: alice.persona.did, scope: enterprise, actions: ['pay:receive'], validUntil: new Date(Date.now() + 5 * 86_400_000).toISOString(), parent: digestMultibase(payVac), depth: 1 } as any),
      ),
      { pod: SLUG },
    );

    const steward: SessionClaims = { subject: 'did:key:z6MkStewardForRevocation', pod: POD_DID, tier: 'T3', authorities: ['pep:review'] };
    const revoked = await h.callRoute(h.vta as any, 'POST', '/authority/revoke', { digest: digestMultibase(payVac), reason: 'Enterprise closed.' }, steward);
    expect(revoked.status).toBe(200);

    await refreshTier(alice.wallet, alice.client);
    const row = (await alice.wallet.credentials(SLUG)).find((c) => c.digest === digestMultibase(payVac));
    expect(row!.status).toBe('superseded');
    expect((await alice.wallet.credentials(SLUG)).find((c) => c.digest === staff)!.status).not.toBe('superseded');
    const rootVacs = (await alice.wallet.activeVacs(SLUG)).filter((v) => v.credentialSubject['authority'].scope === enterprise && !v.credentialSubject['authority'].parent);
    expect(rootVacs).toEqual([]);
    expect(alice.jar.session!.authorities).not.toContain(`pay:receive@${enterprise}`);
    // The tier permissions are untouched.
    expect(await alice.wallet.authorities(SLUG)).toEqual(expect.arrayContaining(tierDefaultActions('T1')));
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
