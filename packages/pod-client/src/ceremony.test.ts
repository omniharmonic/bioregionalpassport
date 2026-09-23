import 'fake-indexeddb/auto';
import { digestMultibase, randomNonce } from '@passport/credential-core';
import { boulderManifest } from '@passport/tenant-config';
import { afterEach, describe, expect, it } from 'vitest';
import { Ceremony, pairDigest, parseInvite } from './ceremony.js';
import { MemoryRelay } from './relay.js';
import { eventChannel } from './util.js';
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
    // Mallory offers a half made out to someone else on Alice's channel.
    const other = await phone();
    const otherSession = await new Ceremony({ wallet: other, relay, pod: 'boulder' }).host();
    const j = await new Ceremony({ wallet: mallory, relay, pod: 'boulder' }).join(otherSession.inviteJson);
    await relay.post(s.channel, j.myDid, { type: 'org.bioregion.vrc.offer', createdAt: new Date().toISOString(), seq: 9, vrc: j.vrcOut });
    await expect(host.pollHost(s)).rejects.toThrow('made out to someone else');
    await expect(new Ceremony({ wallet: alice, relay, pod: 'boulder' }).join('{"hello":1}')).rejects.toThrow('not a passport invitation');
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
