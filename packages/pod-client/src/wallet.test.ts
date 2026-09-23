import 'fake-indexeddb/auto';
import { keyPairFromSeed, randomNonce } from '@passport/credential-core';
import { boulderManifest, tenantZeroManifest } from '@passport/tenant-config';
import { afterEach, describe, expect, it } from 'vitest';
import { Outbox } from './outbox.js';
import { createWallet, openWallet, Wallet } from './wallet.js';
import { abbreviateDid, channelFor } from './util.js';
import { CHANNEL_RE } from './relay.js';

const open: Wallet[] = [];
const fresh = async () => {
  const w = await createWallet({ name: `w-${randomNonce(6)}` });
  open.push(w);
  return w;
};
afterEach(async () => {
  for (const w of open.splice(0)) await w.forget();
});

describe('wallet', () => {
  it('creates a passport with a root identifier, once', async () => {
    const name = `w-${randomNonce(6)}`;
    const before = openWallet({ name });
    expect(await before.exists()).toBe(false);
    const w = await createWallet({ name });
    open.push(w);
    expect(await w.exists()).toBe(true);
    const { rootDid } = await w.init();
    expect(rootDid).toBe(await w.rootDid());
    const ids = await w.identifiers();
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ did: rootDid, scope: 'public' });
  });

  it('mints a directed persona per pod and pairwise identifiers', async () => {
    const w = await fresh();
    const persona = await w.mintPersona('boulder');
    expect(persona.did).toMatch(/^did:key:z6Mk/);
    await w.addPod(boulderManifest, persona.did);
    expect((await w.mintPersona('boulder')).did).toBe(persona.did); // idempotent per pod
    expect((await w.personaFor('boulder'))!.did).toBe(persona.did);
    const row = await w.db.identifiers.get(persona.did);
    expect(row).toMatchObject({ scope: 'directed', pod: 'boulder' });
    // The stored seed reproduces the key.
    expect(keyPairFromSeed(new Uint8Array(row!.seed)).did).toBe(persona.did);

    const pw = await w.mintPairwise('boulder', 'did:key:z6MkOther');
    expect(await w.db.identifiers.get(pw.did)).toMatchObject({ scope: 'pairwise', pod: 'boulder', counterparty: 'did:key:z6MkOther' });

    // Second pod: new identifier by default, or reuse on request (FR-ID-6).
    const second = await w.mintPersona('tenant-zero');
    expect(second.did).not.toBe(persona.did);
    const w2 = await fresh();
    const p1 = await w2.mintPersona('boulder');
    await w2.addPod(boulderManifest, p1.did);
    const reused = await w2.mintPersona('tenant-zero', { reuse: p1.did });
    await w2.addPod(tenantZeroManifest, reused.did);
    expect((await w2.personaFor('tenant-zero'))!.did).toBe(p1.did);
  });

  it('explains what it cannot present', async () => {
    const w = await fresh();
    const persona = await w.mintPersona('boulder');
    await w.addPod(boulderManifest, persona.did);
    await expect(w.selectFor('boulder', ['MembershipCredential:pod'])).rejects.toThrow('This needs membership in Boulder Commons');
    await expect(w.selectFor('boulder')).rejects.toThrow('You are not a member of Boulder Commons yet.');
  });

  it('derives relay channels the relay accepts and abbreviates identifiers', () => {
    const ch = channelFor(randomNonce(24));
    expect(ch).toMatch(CHANNEL_RE);
    expect(abbreviateDid('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK')).toBe('z6Mkha…2doK');
  });

  it('queues relay posts while offline and flushes them when back online', async () => {
    const w = await fresh();
    const sent: string[] = [];
    let online = false;
    const fetchImpl = async (url: string) => {
      if (!online) throw new TypeError('Failed to fetch');
      sent.push(url);
      return new Response(JSON.stringify({ seq: 1 }), { status: 201 });
    };
    const outbox = new Outbox(w.db, fetchImpl);
    const r = await outbox.enqueue({ url: '/api/vta/relay/abcdefghijklmnopq', method: 'POST', body: { sender: 'x', body: {} } }, { durable: true });
    expect(r.queued).toBe(true);
    await expect(outbox.enqueue({ url: '/api/vta/session', method: 'POST', body: {} })).rejects.toThrow(/offline/);
    expect(await outbox.pending()).toHaveLength(1);
    online = true;
    expect(await outbox.flush()).toEqual({ sent: 1, failed: 0, remaining: 0 });
    expect(sent).toEqual(['/api/vta/relay/abcdefghijklmnopq']);
  });
});
