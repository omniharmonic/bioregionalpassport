import 'fake-indexeddb/auto';
import { digestMultibase, generateKeyPair, keyPairForDid, randomNonce, signDocument, buildWitness } from '@passport/credential-core';
import { issueAuthorities, MEETING_PREFIX } from '@passport/pod-vta';
import { boulderManifest, defaultTrustPolicy, type TrustPolicy } from '@passport/tenant-config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ceremony, parseInvite, parseWitnessInvite, WITNESS_GOAL } from './ceremony.js';
import { PodClient } from './client.js';
import { acceptMembership, applyForMembership } from './membership.js';
import { channelFor, matchCode, PodError, vacActions } from './util.js';
import { createWallet, type Wallet } from './wallet.js';
import { createHarness, POD_DID, SLUG, type Harness } from './test/harness.js';

/** Peer witnessing (Task 21c): a Trusted (T2) member witnesses two neighbors on the spot, no scheduled event. */
const policy: TrustPolicy = { ...defaultTrustPolicy(POD_DID), admission: { witnessTier: 'T2', peerWitnessing: true } };

let h: Harness;
const wallets: Wallet[] = [];
beforeAll(async () => {
  h = await createHarness({ policy });
});
afterAll(async () => {
  for (const w of wallets) await w.forget();
  await h.close();
});

async function phone() {
  const wallet = await createWallet({ name: `peer-${randomNonce(6)}` });
  wallets.push(wallet);
  const persona = await wallet.mintPersona(SLUG);
  await wallet.addPod(boulderManifest, persona.did);
  const fetch = h.fetchFor();
  const client = new PodClient({ slug: SLUG, manifest: boulderManifest, baseUrl: '', fetch, persona, db: wallet.db });
  return { wallet, persona, client, jar: fetch.jar, ceremony: new Ceremony({ wallet, relay: client.relay(), pod: SLUG, resolver: h.deps.resolver }) };
}
type Phone = Awaited<ReturnType<typeof phone>>;

/** A Trusted (T2) member: a `members` row at T2 and the PEP's T2 VAC, which carries `vwc:issue` under this policy. */
async function trusted(p: Phone) {
  const issued = await h.run(async (ctx) => {
    await ctx.db.query('INSERT INTO members (did, tier, joined_at) VALUES ($1, $2, $3)', [p.persona.did, 'T2', new Date().toISOString()]);
    return issueAuthorities(ctx, h.deps, p.persona.did, 'T2', []);
  });
  await p.wallet.replaceVacs(SLUG, issued.vacs);
  const actions = vacActions(issued.vacs[0]!);
  p.jar.session = { subject: p.persona.did, pod: POD_DID, tier: 'T2', authorities: actions };
  return actions;
}

async function meet(a: Phone, b: Phone) {
  const s = await b.ceremony.host();
  const j = await a.ceremony.join(s.inviteJson);
  const bMet = await b.ceremony.pollHost(s);
  const aMet = await a.ceremony.pollJoin(j);
  expect(aMet!.edgeDigest).toBe(bMet!.edgeDigest);
  return aMet!;
}

describe('peer witnessing against the real pod VTA', () => {
  it('a T2 witness shows a channel QR, both neighbors ask, the witness witnesses, both are admitted', async () => {
    const dana = await phone(); // Trusted neighbor who witnesses
    const alice = await phone();
    const bob = await phone();
    expect(await trusted(dana)).toContain('vwc:issue');
    expect(await dana.wallet.authorities(SLUG)).toContain('vwc:issue');

    const met = await meet(alice, bob);

    // The witness channel: an OOB invite with a fresh challenge, no event, marked as a witness code.
    const channel = await dana.ceremony.hostWitness();
    const invite = parseWitnessInvite(channel.inviteJson);
    expect(invite).toMatchObject({ type: 'org.bioregion.oob.invite', pod: SLUG, pairwiseDid: dana.persona.did });
    expect(invite.event).toBeUndefined();
    expect(JSON.parse(channel.inviteJson).goal).toBe(WITNESS_GOAL);
    expect(channel.channel).toBe(channelFor(invite.challenge));
    // It is not a "meet me" code, and a meet code is not a witness code.
    await expect(alice.ceremony.join(channel.inviteJson)).rejects.toThrow('This is a witness code');
    const meetCode = await bob.ceremony.host();
    await expect(alice.ceremony.requestPeerWitness(meetCode.inviteJson, bob.persona.did)).rejects.toThrow('That is not a witness code');

    // Both neighbors scan it and ask; the witness sees the pair once.
    expect(await dana.ceremony.listPeerWitnessRequests(channel)).toEqual([]);
    const asked = await alice.ceremony.requestPeerWitness(channel.inviteJson, bob.persona.did);
    expect(asked).toMatchObject({ queued: false, edgeDigest: met.edgeDigest, witness: dana.persona.did });
    await bob.ceremony.requestPeerWitness(channel.inviteJson, alice.persona.did);
    expect((await alice.wallet.contact(bob.persona.did))!.witnessRequested).toMatchObject({ event: 'meeting', channel: channel.channel, witness: dana.persona.did });
    const requests = await dana.ceremony.listPeerWitnessRequests(channel);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ edgeDigest: met.edgeDigest, taskContext: 'meeting' });

    // A forged answer (not signed by the pod) neither hides the request nor reaches the requesters.
    const forger = keyPairForDid(POD_DID, generateKeyPair().privateKey);
    const forged = signDocument(
      buildWitness({ issuer: POD_DID, edgeDigest: met.edgeDigest, taskContext: `${MEETING_PREFIX}forged`, taskDigest: 'zForged', evidence: 'liveness', validUntil: new Date(Date.now() + 365 * 864e5).toISOString() }),
      forger,
    );
    await alice.client.relayPost(channel.channel, alice.persona.did, { type: 'org.bioregion.witness.result', createdAt: new Date().toISOString(), seq: 99, vwc: forged });
    expect(await dana.ceremony.listPeerWitnessRequests(channel)).toHaveLength(1);
    expect(await alice.ceremony.pollPeerWitnessResult(bob.persona.did)).toBeUndefined();

    // "I saw these two people together" → POST /witness (liveness) → witness.result on the channel.
    const out = await dana.ceremony.witnessPeer(dana.client, channel, requests[0]!, { place: { name: 'Farmers market' } });
    expect(out.vwc).toMatchObject({
      issuer: POD_DID,
      credentialSubject: { predicate: 'dtg:witnessed', witnessedBy: dana.persona.did, evidence: 'liveness', object: { digestMultibase: met.edgeDigest } },
    });
    expect(String(out.vwc.credentialSubject['taskContext'])).toMatch(new RegExp(`^${MEETING_PREFIX}`));
    expect(out.task).toMatchObject({ id: out.vwc.credentialSubject['taskContext'], kind: 'meeting', attestation: true });
    expect(await dana.ceremony.listPeerWitnessRequests(channel)).toHaveLength(0);

    // Both requesters' polling picks up the verified result; apply/ack continue unchanged.
    expect(digestMultibase((await alice.ceremony.pollPeerWitnessResult(bob.persona.did))!)).toBe(digestMultibase(out.vwc));
    expect(digestMultibase((await bob.ceremony.pollPeerWitnessResult(alice.persona.did))!)).toBe(digestMultibase(out.vwc));
    const grant = await applyForMembership(alice.wallet, alice.client, bob.persona.did);
    const accepted = await acceptMembership(alice.wallet, alice.client, grant, { resolver: h.deps.resolver });
    expect(accepted.member).toMatchObject({ did: alice.persona.did, tier: 'T1' });
    const bobGrant = await applyForMembership(bob.wallet, bob.client, alice.persona.did);
    expect(bobGrant.credentialSubject.id).toBe(bob.persona.did);

    // A new T1 member does not hold vwc:issue, so cannot witness on the spot.
    expect(await alice.wallet.authorities(SLUG)).not.toContain('vwc:issue');
    const err = await alice.client.witnessMeeting(met.vrcOut, met.vrcIn).catch((e) => e);
    expect(err).toBeInstanceOf(PodError);
    expect(err.status).toBe(403);
  });

  it('asking a second witness never orphans the first; the other neighbor gets the result via the relationship', async () => {
    const dana = await phone(); // witness 1
    const gus = await phone(); // witness 2
    const alice = await phone();
    const bob = await phone(); // never scans any witness code
    await trusted(dana);
    await trusted(gus);
    const met = await meet(alice, bob);
    const ch1 = await dana.ceremony.hostWitness();
    const ch2 = await gus.ceremony.hostWitness();
    await alice.ceremony.requestPeerWitness(ch1.inviteJson, bob.persona.did);
    await alice.ceremony.requestPeerWitness(ch2.inviteJson, bob.persona.did);
    expect((await alice.wallet.contact(bob.persona.did))!.witnessChannels).toEqual([ch1.channel, ch2.channel]);

    // The matching code is the same on the neighbor's waiting card and on each witness's card.
    const [req1] = await dana.ceremony.listPeerWitnessRequests(ch1);
    const [req2] = await gus.ceremony.listPeerWitnessRequests(ch2);
    const aliceCode = matchCode((await alice.wallet.contact(bob.persona.did))!.edgeDigest!);
    expect(aliceCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(matchCode(req1!.edgeDigest)).toBe(aliceCode);
    expect(matchCode(req2!.edgeDigest)).toBe(aliceCode);
    expect(matchCode(met.edgeDigest)).toBe(aliceCode);

    // Witness 1 taps after Alice already asked witness 2: Alice still receives it.
    const out = await dana.ceremony.witnessPeer(dana.client, ch1, req1!);
    expect(digestMultibase((await alice.ceremony.pollPeerWitnessResult(bob.persona.did))!)).toBe(digestMultibase(out.vwc));
    // Alice forwarded it: witness 2's queue closes, and Bob (who never scanned) gets it over the relationship channel.
    expect(await gus.ceremony.listPeerWitnessRequests(ch2)).toEqual([]);
    expect(digestMultibase((await bob.ceremony.pollPeerWitnessResult(alice.persona.did))!)).toBe(digestMultibase(out.vwc));
    // Had witness 2 tapped first-come anyway, the pod answers 409 (a pair is witnessed once per pod).
    const late = await gus.client.witnessMeeting(req2!.vrcA, req2!.vrcB).catch((e) => e);
    expect(late).toMatchObject({ status: 409, code: 'ALREADY_WITNESSED' });
    const grant = await applyForMembership(bob.wallet, bob.client, alice.persona.did);
    expect(grant.credentialSubject.id).toBe(bob.persona.did);
  });

  it('refuses a witness who is one of the two people', async () => {
    const dana = await phone();
    const erin = await phone();
    await trusted(dana);
    await meet(erin, dana);
    const channel = await dana.ceremony.hostWitness();
    await expect(erin.ceremony.requestPeerWitness(channel.inviteJson, dana.persona.did)).rejects.toThrow('Your witness must be someone other than the two of you.');
    expect(parseInvite(channel.inviteJson).event).toBeUndefined();
  });
});
