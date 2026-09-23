import 'fake-indexeddb/auto';
import { keyPairFromSeed, randomNonce } from '@passport/credential-core';
import { boulderManifest, tenantZeroManifest } from '@passport/tenant-config';
import { afterAll } from 'vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { Outbox } from './outbox.js';
import { PodClient } from './client.js';
import { checkPaymentRequest } from './pay.js';
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

describe('pod client origin', () => {
  const g = globalThis as { location?: { origin: string } };
  afterAll(() => {
    delete g.location;
  });

  it('never sends one pod\'s calls to another pod\'s host', async () => {
    const seen: { url: string; credentials?: RequestCredentials; pod?: string }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push({ url, ...(init?.credentials ? { credentials: init.credentials } : {}), pod: (init?.headers as Record<string, string>)['x-pod'] });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    };
    // A wallet page on pod A's host (boulder) calling pod B (tenant-zero): B's own origin, credentials included.
    g.location = { origin: 'https://boulder.bioregionalpassport.org' };
    const b = new PodClient({ slug: 'tenant-zero', manifest: tenantZeroManifest, fetch: fetchImpl });
    expect(b.serviceUrl('vta')).toBe('https://tenant-zero.bioregionalpassport.org/api/vta');
    await b.events();
    expect(seen.at(-1)).toEqual({ url: 'https://tenant-zero.bioregionalpassport.org/api/vta/events', credentials: 'include', pod: 'tenant-zero' });
    // Even for pod A itself, a pod host is not the canonical wallet origin.
    expect(new PodClient({ slug: 'boulder', manifest: boulderManifest, fetch: fetchImpl }).serviceUrl('vta')).toBe('https://boulder.bioregionalpassport.org/api/vta');
    // On the platform host every pod is same-origin with an X-Pod header.
    g.location = { origin: 'https://bioregionalpassport.org' };
    const onPlatform = new PodClient({ slug: 'tenant-zero', manifest: tenantZeroManifest, fetch: fetchImpl });
    await onPlatform.events();
    expect(seen.at(-1)).toEqual({ url: '/api/vta/events', credentials: 'same-origin', pod: 'tenant-zero' });
    g.location = { origin: 'http://localhost:3000' };
    expect(new PodClient({ slug: 'boulder', manifest: boulderManifest, fetch: fetchImpl }).serviceUrl('vta')).toBe('/api/vta');
  });

  it('refuses payment requests in the wrong unit or above the sale', () => {
    const base = {
      type: 'org.bioregion.pay.request' as const,
      merchant: 'did:web:x',
      pod: boulderManifest.identity.did,
      node: 'n',
      amount: { unit: 'credit', value: 5 },
      totalSale: { unit: 'USD', value: 20 },
      invoice: 'i',
      expires: new Date(Date.now() + 60_000).toISOString(),
      acceptance: { maxShare: 0.5, requires: [] },
    };
    expect(checkPaymentRequest(base, boulderManifest)).toBeUndefined();
    expect(checkPaymentRequest({ ...base, amount: { unit: 'USD', value: 5 } }, boulderManifest)).toBe('This payment request asks for USD, but Boulder Commons uses credits.');
    expect(checkPaymentRequest({ ...base, amount: { unit: 'credit', value: 25 } }, boulderManifest)).toBe('This payment request asks for more credits than the whole sale.');
    expect(checkPaymentRequest({ ...base, pod: tenantZeroManifest.identity.did }, boulderManifest)).toBe('This payment request is not from Boulder Commons.');
  });
});
