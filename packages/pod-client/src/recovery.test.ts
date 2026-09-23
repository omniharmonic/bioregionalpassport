import 'fake-indexeddb/auto';
import { buildRelationship, randomNonce, signDocument } from '@passport/credential-core';
import { boulderManifest } from '@passport/tenant-config';
import { afterEach, describe, expect, it } from 'vitest';
import { createShares, exportBackup, exportCredentialsJson, importBackup, recoverFromShares, recoveryStatus } from './recovery.js';
import { createWallet, type Wallet } from './wallet.js';

const open: Wallet[] = [];
const fresh = async () => {
  const w = await createWallet({ name: `r-${randomNonce(6)}` });
  open.push(w);
  return w;
};
afterEach(async () => {
  for (const w of open.splice(0)) await w.forget();
});

async function populated(): Promise<Wallet> {
  const w = await fresh();
  const persona = await w.mintPersona('boulder');
  await w.addPod(boulderManifest, persona.did);
  await w.mintPairwise('boulder', 'did:key:z6MkFriend');
  const vrc = signDocument(buildRelationship({ issuer: persona.did, subject: 'did:key:z6MkFriend', bioregion: 'boulder', formedAt: new Date().toISOString() }), persona);
  await w.storeCredential(vrc, { pod: 'boulder' });
  return w;
}

describe('recovery', () => {
  it('backup → import round trip restores keys, pods and credentials', async () => {
    const a = await populated();
    const status0 = await recoveryStatus(a);
    expect(status0.newKeysSinceBackup).toBe(3);
    const file = await exportBackup(a, 'correct horse battery');
    expect(file.filename).toMatch(/^passport-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(file.text).not.toContain((await a.personaFor('boulder'))!.did); // encrypted
    expect((await recoveryStatus(a)).newKeysSinceBackup).toBe(0);

    const b = await fresh();
    await expect(importBackup(b, file.text, 'wrong passphrase')).rejects.toThrow('wrong passphrase');
    const r = await importBackup(b, new Blob([file.text]), 'correct horse battery');
    expect(r).toMatchObject({ pods: 1, credentials: 1 });
    expect((await b.personaFor('boulder'))!.did).toBe((await a.personaFor('boulder'))!.did);
    expect((await b.personaFor('boulder'))!.privateKey).toEqual((await a.personaFor('boulder'))!.privateKey);
    expect(await b.credentials('boulder')).toHaveLength(1);
    expect(await b.rootDid()).toBe(await a.rootDid());

    const creds = JSON.parse((await exportCredentialsJson(a)).text);
    expect(creds.credentials).toHaveLength(1);
    expect(JSON.stringify(creds)).not.toContain('seed');
  });

  it('any two of three shares restore every identifier', async () => {
    const a = await populated();
    const shares = await createShares(a);
    expect(shares).toHaveLength(3);
    for (const s of shares) expect(s).toMatch(/^passport-share-v1\.[A-Za-z0-9_-]+$/);
    const want = (await a.identifiers()).map((r) => r.did).sort();
    for (const pair of [[0, 1], [0, 2], [1, 2]] as const) {
      const b = await fresh();
      const r = await recoverFromShares(b, [shares[pair[0]]!, shares[pair[1]]!]);
      expect(r.rootDid).toBe(await a.rootDid());
      const got = (await b.identifiers()).map((x) => x.did);
      for (const did of want) expect(got).toContain(did);
      const persona = (await a.personaFor('boulder'))!;
      expect((await b.keyFor(persona.did))!.privateKey).toEqual(persona.privateKey);
    }
    const c = await fresh();
    await expect(recoverFromShares(c, [shares[0]!])).rejects.toThrow('Two recovery shares are needed.');
    await expect(recoverFromShares(c, [shares[0]!, shares[0]!])).rejects.toThrow();
  });
});
