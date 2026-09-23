import 'fake-indexeddb/auto';
import { buildMembershipGrant, buildWitness, createResolver, didWebDocument, digestMultibase, generateKeyPair, keyPairForDid, randomNonce, signDocument, type KeyPair } from '@passport/credential-core';
import { boulderManifest } from '@passport/tenant-config';
import { afterEach, describe, expect, it } from 'vitest';
import { Ceremony, pairDigest, parseInvite, parseWitnessInvite } from './ceremony.js';
import { MemoryRelay } from './relay.js';
import { eventChannel } from './util.js';
import { verifyGrant } from './membership.js';

const POD_DID = boulderManifest.identity.did;
import { createWallet, type Wallet } from './wallet.js';

const open: Wallet[] = [];
async function phone(): Promise<Wallet> {
  const w = await createWallet({ name: `phone-${randomNonce(6)}` });
  const persona = await w.mintPersona('boulder');
  await w.addPod(boulderManifest, persona.did);
  open.push(w);
  return w;
}
afterEach(async () => {
  for (const w of open.splice(0)) await w.forget();
});

describe('ceremony over a relay', () => {
  it('two phones exchange mirrored VRC halves with matching digests', async () => {
    const relay = new MemoryRelay();
    const alice = await phone();
    const bob = await phone();
    const host = new Ceremony({ wallet: bob, relay, pod: 'boulder' });
    const guest = new Ceremony({ wallet: alice, relay, pod: 'boulder' });

    const session = await host.host({ event: 'evt_1' });
    expect(parseInvite(session.inviteJson)).toMatchObject({ type: 'org.bioregion.oob.invite', pod: 'boulder', pairwiseDid: session.myDid, event: 'evt_1' });
    expect(await host.pollHost(session)).toBeNull();

    const joined = await guest.join(session.inviteJson, { vouch: 'lives-here' });
    const hostMet = await host.pollHost(session);
    const guestMet = await guest.pollJoin(joined);
    expect(hostMet && guestMet).toBeTruthy();

    const aliceDid = (await alice.personaFor('boulder'))!.did;
    const bobDid = (await bob.personaFor('boulder'))!.did;
    // Mirrored: each side's outgoing half is the other's incoming half, byte for byte.
    expect(digestMultibase(guestMet!.vrcOut)).toBe(digestMultibase(hostMet!.vrcIn));
    expect(digestMultibase(hostMet!.vrcOut)).toBe(digestMultibase(guestMet!.vrcIn));
    expect(guestMet!.edgeDigest).toBe(hostMet!.edgeDigest);
    expect(guestMet!.edgeDigest).toBe(pairDigest(guestMet!.vrcIn, guestMet!.vrcOut));
    expect(guestMet!.vrcOut).toMatchObject({ issuer: aliceDid, credentialSubject: { id: bobDid, bioregion: 'boulder', bioregionScope: 'pairwise' } });
    expect(hostMet!.vrcOut).toMatchObject({ issuer: bobDid, credentialSubject: { id: aliceDid } });

    // Both store the contact and both halves.
    expect(await bob.contact(aliceDid)).toMatchObject({ pod: 'boulder', myDid: bobDid, event: 'evt_1' });
    expect((await bob.contact(aliceDid))!.vecIn).toMatchObject({ issuer: aliceDid, credentialSubject: { predicate: 'dtg:endorses', object: { value: { scope: 'lives-here' } } } });
    expect((await alice.credentials('boulder')).filter((c) => c.kind === 'relationship')).toHaveLength(2);
    expect((await bob.credentials('boulder')).filter((c) => c.kind === 'relationship')).toHaveLength(2);

    // A later vouch travels over the same channel.
    const { vec } = await host.vouch(aliceDid, 'worked-with');
    expect(await guest.syncContacts()).toEqual([bobDid]);
    expect(digestMultibase((await alice.contact(bobDid))!.vecIn!)).toBe(digestMultibase(vec));

    // Witness request on the event channel, seen by a convener, answered once.
    const event = { id: 'evt_1', taskDigest: 'zTask' };
    await guest.requestWitness(event, bobDid);
    await guest.requestWitness(event, bobDid); // duplicate request collapses
    const convener = await phone();
    const conv = new Ceremony({ wallet: convener, relay, pod: 'boulder' });
    const open = await conv.listWitnessRequests(event);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ edgeDigest: guestMet!.edgeDigest, requester: aliceDid, taskContext: 'evt_1' });
    expect(relay.channels.has(eventChannel(event))).toBe(true);
  });

  it('refuses a half that is not addressed to me, and my own code', async () => {
    const relay = new MemoryRelay();
    const alice = await phone();
    const mallory = await phone();
    const host = new Ceremony({ wallet: alice, relay, pod: 'boulder' });
    const s = await host.host();
    await expect(new Ceremony({ wallet: alice, relay, pod: 'boulder' }).join(s.inviteJson)).rejects.toThrow('This is your own code');
    // Mallory offers a half made out to someone else on Alice's channel, then a malformed body: both are ignored
    // and hosting continues until the real offer arrives.
    const other = await phone();
    const otherSession = await new Ceremony({ wallet: other, relay, pod: 'boulder' }).host();
    const j = await new Ceremony({ wallet: mallory, relay, pod: 'boulder' }).join(otherSession.inviteJson);
    await relay.post(s.channel, j.myDid, { type: 'org.bioregion.vrc.offer', createdAt: new Date().toISOString(), seq: 9, vrc: j.vrcOut });
    const r = relay as unknown as { seq: number };
    relay.channels.get(s.channel)!.push({ seq: ++r.seq, sender: 'x', body: { type: 'org.bioregion.vrc.offer', vrc: 'nonsense' }, createdAt: new Date().toISOString() });
    expect(await host.pollHost(s)).toBeNull();
    expect(s.rejected).toBe(1);
    expect(s.lastRejection).toMatch('made out to someone else');
    const real = await phone();
    const realJoin = new Ceremony({ wallet: real, relay, pod: 'boulder' });
    const rj = await realJoin.join(s.inviteJson);
    const met = await host.waitForOffer(s, { intervalMs: 5 });
    expect(met.contact.did).toBe(rj.myDid);
    await expect(new Ceremony({ wallet: alice, relay, pod: 'boulder' }).join('{"hello":1}')).rejects.toThrow('not a passport invitation');
  });

  it('trusts only pod-signed witness results for my relationship, and verifies membership offers', async () => {
    const relay = new MemoryRelay();
    const podKey = keyPairForDid(POD_DID, generateKeyPair().privateKey);
    const resolver = createResolver({ staticDocs: { [POD_DID]: didWebDocument(POD_DID, podKey.publicKeyMultibase) } });
    const a = await phone();
    const b = await phone();
    const ca = new Ceremony({ wallet: a, relay, pod: 'boulder', resolver });
    const cb = new Ceremony({ wallet: b, relay, pod: 'boulder', resolver });
    const s = await cb.host();
    const j = await ca.join(s.inviteJson);
    const met = (await cb.pollHost(s))!;
    await ca.pollJoin(j);
    const bDid = met.vrcOut.issuer;
    const event = { id: 'evt_w', taskDigest: 'zTask' };
    await ca.requestWitness(event, bDid);
    const vwcFor = (key: KeyPair, edge: string) =>
      signDocument(
        { ...buildWitness({ issuer: POD_DID, edgeDigest: edge, taskContext: event.id, taskDigest: 'zTask', evidence: 'same-event', validUntil: new Date(Date.now() + 86_400_000).toISOString() }) },
        key,
      );
    const post = (vwc: unknown) => relay.post(eventChannel(event), 'someone', { type: 'org.bioregion.witness.result', createdAt: new Date().toISOString(), seq: 1, vwc });
    // Forged: claims the pod as issuer but is signed by another key; and a real pod signature over another edge.
    await post(vwcFor(keyPairForDid(POD_DID, generateKeyPair().privateKey), met.edgeDigest));
    await post(vwcFor(podKey, 'zSomeOtherEdge'));
    expect(await ca.pollWitnessResult(event, bDid)).toBeUndefined();
    expect(await cb.listWitnessRequests(event)).toHaveLength(1); // forged answers do not hide the request
    await post(vwcFor(podKey, met.edgeDigest));
    expect(await ca.pollWitnessResult(event, bDid)).toMatchObject({ issuer: POD_DID });
    expect(await cb.listWitnessRequests(event)).toHaveLength(0);

    // Membership offers: only a pod-signed grant to my persona from a pod I joined.
    const persona = (await a.personaFor('boulder'))!.did;
    const grantTo = (member: string, key: KeyPair = podKey) =>
      signDocument(buildMembershipGrant({ pod: POD_DID, member, bioregion: 'boulder', placeIds: [], governance: 'https://g', validUntil: new Date(Date.now() + 86_400_000).toISOString() }), key);
    expect((await verifyGrant(a, grantTo(persona), resolver)).slug).toBe('boulder');
    await expect(verifyGrant(a, grantTo(persona, keyPairForDid(POD_DID, generateKeyPair().privateKey)), resolver)).rejects.toThrow('not signed by Boulder Commons');
    await expect(verifyGrant(a, grantTo('did:key:z6MkSomeoneElse'), resolver)).rejects.toThrow('made out to a different identifier');
    const stranger = { ...grantTo(persona), issuer: 'did:web:example.org:dids:elsewhere' };
    await expect(verifyGrant(a, stranger, resolver)).rejects.toThrow('not from a pod your passport has joined');
  });

  it('peer witness channel: results bound to any meeting task are verified, event results stay event-bound', async () => {
    const relay = new MemoryRelay();
    const podKey = keyPairForDid(POD_DID, generateKeyPair().privateKey);
    const resolver = createResolver({ staticDocs: { [POD_DID]: didWebDocument(POD_DID, podKey.publicKeyMultibase) } });
    const a = await phone();
    const b = await phone();
    const w = await phone();
    const ca = new Ceremony({ wallet: a, relay, pod: 'boulder', resolver });
    const cb = new Ceremony({ wallet: b, relay, pod: 'boulder', resolver });
    const cw = new Ceremony({ wallet: w, relay, pod: 'boulder', resolver });
    const s = await cb.host();
    const j = await ca.join(s.inviteJson);
    const met = (await cb.pollHost(s))!;
    await ca.pollJoin(j);
    const bDid = met.vrcOut.issuer;

    const channel = await cw.hostWitness();
    expect(() => parseWitnessInvite(s.inviteJson)).toThrow('That is not a witness code');
    await expect(ca.join(channel.inviteJson)).rejects.toThrow('This is a witness code');
    // A request whose halves are not genuinely signed is never listed.
    const tampered = { ...met.vrcIn, credentialSubject: { ...met.vrcIn.credentialSubject, formedAt: '2020-01-01T00:00:00Z' } };
    await relay.post(channel.channel, 'x', { type: 'org.bioregion.witness.request', createdAt: new Date().toISOString(), seq: 1, edgeDigest: pairDigest(met.vrcOut, tampered), taskContext: 'meeting', requester: 'x', vrcA: met.vrcOut, vrcB: tampered });
    expect(await cw.listPeerWitnessRequests(channel)).toHaveLength(0);
    await ca.requestPeerWitness(channel.inviteJson, bDid);
    await ca.requestPeerWitness(channel.inviteJson, bDid); // a repeat collapses to one request
    expect(await cw.listPeerWitnessRequests(channel)).toHaveLength(1);
    expect(await ca.pollPeerWitnessResult(bDid)).toBeUndefined();

    const vwcFor = (key: KeyPair, edge: string, task: string) =>
      signDocument(buildWitness({ issuer: POD_DID, edgeDigest: edge, taskContext: task, taskDigest: 'zTask', evidence: 'liveness', validUntil: new Date(Date.now() + 365 * 864e5).toISOString() }), key);
    const post = (vwc: unknown) => relay.post(channel.channel, 'someone', { type: 'org.bioregion.witness.result', createdAt: new Date().toISOString(), seq: 1, vwc });
    await post(vwcFor(keyPairForDid(POD_DID, generateKeyPair().privateKey), met.edgeDigest, 'meet-x'));
    await post(vwcFor(podKey, 'zSomeOtherEdge', 'meet-x'));
    expect(await ca.pollPeerWitnessResult(bDid)).toBeUndefined();
    expect(await cw.listPeerWitnessRequests(channel)).toHaveLength(1);
    const good = vwcFor(podKey, met.edgeDigest, 'meet-abc');
    await post(good);
    expect(await ca.pollPeerWitnessResult(bDid)).toMatchObject({ issuer: POD_DID });
    expect(await cw.listPeerWitnessRequests(channel)).toHaveLength(0);
    // The same meeting VWC is not accepted as an answer at an event it is not bound to.
    expect(await ca.verifyWitnessResult(good, { id: 'evt_other' }, met.edgeDigest)).toBeUndefined();
    expect(await ca.verifyWitnessResult(good, null, met.edgeDigest)).toBeTruthy();
  });

  it('can sign with a pairwise identifier instead of the persona', async () => {
    const relay = new MemoryRelay();
    const a = await phone();
    const b = await phone();
    const host = new Ceremony({ wallet: a, relay, pod: 'boulder', identity: 'pairwise' });
    const s = await host.host();
    const persona = (await a.personaFor('boulder'))!.did;
    expect(s.myDid).not.toBe(persona);
    const guest = new Ceremony({ wallet: b, relay, pod: 'boulder' });
    const j = await guest.join(s.inviteJson);
    const met = await host.pollHost(s);
    await guest.pollJoin(j);
    expect(met!.vrcOut.issuer).toBe(s.myDid);
    expect(await a.db.identifiers.get(s.myDid)).toMatchObject({ scope: 'pairwise', counterparty: j.myDid });
  });
});
