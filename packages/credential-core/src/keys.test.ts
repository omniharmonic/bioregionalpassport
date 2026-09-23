import { describe, expect, it } from 'vitest';
import {
  createResolver,
  deriveRoundKey,
  didKeyDocument,
  didWebDocument,
  didWebFromDomainPath,
  didWebToUrl,
  generateKeyPair,
  keyPairFromSeed,
  multibaseFromDidKey,
  publicKeyFromMultibase,
  publicKeyToMultibase,
} from './index.js';

const seed = (n: number) => new Uint8Array(32).fill(n);

describe('keys', () => {
  it('is deterministic from a seed', () => {
    const a = keyPairFromSeed(seed(7));
    const b = generateKeyPair(seed(7));
    expect(a).toEqual(b);
    expect(a.did).toMatch(/^did:key:z6Mk/);
    expect(a.kid).toBe(`${a.did}#${a.publicKeyMultibase}`);
    expect(keyPairFromSeed(seed(8)).did).not.toBe(a.did);
  });

  it('generates distinct random keys', () => {
    expect(generateKeyPair().did).not.toBe(generateKeyPair().did);
  });

  it('matches the did:key test vector for the RFC 8032 test-1 secret key', () => {
    // RFC 8032 §7.1 TEST 1 secret key → public key d75a9801…; did:key spec example of this key:
    const sk = Uint8Array.from(Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'));
    const kp = keyPairFromSeed(sk);
    expect(Buffer.from(publicKeyFromMultibase(kp.publicKeyMultibase)).toString('hex')).toBe(
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    );
  });

  it('round-trips did:key encode/decode', () => {
    const kp = generateKeyPair();
    const mb = multibaseFromDidKey(kp.did);
    expect(mb).toBe(kp.publicKeyMultibase);
    const pub = publicKeyFromMultibase(mb);
    expect(pub.length).toBe(32);
    expect(publicKeyToMultibase(pub)).toBe(mb);
    expect(() => multibaseFromDidKey('did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme')).toThrow();
  });

  it('derives round keys deterministically per round', () => {
    const r1 = deriveRoundKey(seed(1), 'round-1');
    expect(deriveRoundKey(seed(1), 'round-1')).toEqual(r1);
    expect(deriveRoundKey(seed(1), 'round-2').did).not.toBe(r1.did);
    expect(deriveRoundKey(seed(2), 'round-1').did).not.toBe(r1.did);
    expect(r1.did).not.toBe(keyPairFromSeed(seed(1)).did);
  });
});

describe('DIDs and resolver', () => {
  it('builds did:web identifiers and URLs', () => {
    const did = didWebFromDomainPath('bioregionalpassport.org', 'dids', 'boulder');
    expect(did).toBe('did:web:bioregionalpassport.org:dids:boulder');
    expect(didWebToUrl(did)).toBe('https://bioregionalpassport.org/dids/boulder/did.json');
    expect(didWebToUrl('did:web:example.org')).toBe('https://example.org/.well-known/did.json');
    expect(didWebFromDomainPath('localhost:3000', 'dids', 'x')).toBe('did:web:localhost%3A3000:dids:x');
    expect(didWebToUrl('did:web:localhost%3A3000:dids:x')).toBe('https://localhost:3000/dids/x/did.json');
  });

  it('builds a did:key document', () => {
    const kp = generateKeyPair();
    const doc = didKeyDocument(kp.did);
    expect(doc.id).toBe(kp.did);
    expect(doc.verificationMethod[0]).toEqual({ id: kp.kid, type: 'Multikey', controller: kp.did, publicKeyMultibase: kp.publicKeyMultibase });
    expect(doc.assertionMethod).toEqual([kp.kid]);
    expect(doc.authentication).toEqual([kp.kid]);
  });

  it('resolves static docs first, did:key inline, did:web via fetch with caching', async () => {
    const kp = generateKeyPair();
    const did = didWebFromDomainPath('bioregionalpassport.org', 'dids', 'boulder');
    const webDoc = didWebDocument(did, kp.publicKeyMultibase);
    const staticDid = 'did:web:static.example';
    const staticDoc = didWebDocument(staticDid, kp.publicKeyMultibase);
    const urls: string[] = [];
    const resolver = createResolver({
      staticDocs: { [staticDid]: staticDoc },
      webFetch: async (url) => {
        urls.push(url);
        return webDoc;
      },
    });
    expect(await resolver.resolve(staticDid)).toBe(staticDoc);
    expect((await resolver.resolve(kp.did)).id).toBe(kp.did);
    expect(await resolver.resolve(`${did}#key-1`)).toEqual(webDoc);
    await resolver.resolve(did);
    expect(urls).toEqual(['https://bioregionalpassport.org/dids/boulder/did.json']);
    await expect(resolver.resolve('did:example:123')).rejects.toThrow(/Unsupported/);
  });

  it('rejects a did:web document whose id does not match', async () => {
    const kp = generateKeyPair();
    const resolver = createResolver({ webFetch: async () => didWebDocument('did:web:other.org', kp.publicKeyMultibase) });
    await expect(resolver.resolve('did:web:example.org')).rejects.toThrow(/does not match/);
  });
});
