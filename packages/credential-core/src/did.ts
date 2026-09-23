import { multibaseFromDidKey } from './keys.js';

export interface VerificationMethod {
  id: string;
  type: 'Multikey';
  controller: string;
  publicKeyMultibase: string;
}

export interface DidDocument {
  '@context'?: string | string[];
  id: string;
  verificationMethod: VerificationMethod[];
  assertionMethod: string[];
  authentication: string[];
  service?: any[];
}

export interface DidResolver {
  resolve(did: string): Promise<DidDocument>;
}

const DID_CONTEXTS = ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'];

/** DID document for an Ed25519 did:key (single Multikey method `${did}#${multibase}`). */
export function didKeyDocument(did: string): DidDocument {
  const mb = multibaseFromDidKey(did);
  const id = did.split('#')[0] as string;
  const vmId = `${id}#${mb}`;
  return {
    '@context': DID_CONTEXTS,
    id,
    verificationMethod: [{ id: vmId, type: 'Multikey', controller: id, publicKeyMultibase: mb }],
    assertionMethod: [vmId],
    authentication: [vmId],
  };
}

/** DID document for a did:web with one Multikey method `${did}#key-1`. */
export function didWebDocument(did: string, publicKeyMultibase: string): DidDocument {
  if (!did.startsWith('did:web:')) throw new Error(`Not a did:web: ${did}`);
  const vmId = `${did}#key-1`;
  return {
    '@context': DID_CONTEXTS,
    id: did,
    verificationMethod: [{ id: vmId, type: 'Multikey', controller: did, publicKeyMultibase }],
    assertionMethod: [vmId],
    authentication: [vmId],
  };
}

/** `didWebFromDomainPath('example.org', 'dids', 'boulder')` → `did:web:example.org:dids:boulder`. Ports are %3A-encoded. */
export function didWebFromDomainPath(domain: string, ...path: string[]): string {
  if (!domain) throw new Error('did:web needs a domain.');
  const host = domain.replace(/:/g, '%3A');
  return ['did:web', host, ...path.map((p) => encodeURIComponent(p))].join(':');
}

/** did:web → HTTPS URL of its DID document (bare domain → `/.well-known/did.json`). */
export function didWebToUrl(did: string): string {
  if (!did.startsWith('did:web:')) throw new Error(`Not a did:web: ${did}`);
  const parts = did.slice('did:web:'.length).split('#')[0]!.split(':');
  const domain = decodeURIComponent(parts[0] ?? '');
  if (!domain) throw new Error(`did:web has no domain: ${did}`);
  const path = parts.slice(1).map((p) => decodeURIComponent(p));
  return path.length ? `https://${domain}/${path.join('/')}/did.json` : `https://${domain}/.well-known/did.json`;
}

async function defaultWebFetch(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: 'application/did+json, application/json' } });
  if (!res.ok) throw new Error(`DID document fetch failed (${res.status}) for ${url}`);
  return res.json();
}

/**
 * Method-agnostic resolver. Order: `staticDocs` → did:key (computed inline) → did:web (via `webFetch`,
 * default global `fetch`). Resolved documents are cached for the resolver's lifetime.
 */
export function createResolver(opts: { webFetch?: (url: string) => Promise<any>; staticDocs?: Record<string, DidDocument> } = {}): DidResolver {
  const cache = new Map<string, DidDocument>();
  const webFetch = opts.webFetch ?? defaultWebFetch;
  return {
    async resolve(didUrl: string): Promise<DidDocument> {
      const did = didUrl.split('#')[0] as string;
      const cached = cache.get(did);
      if (cached) return cached;
      let doc: DidDocument;
      const fromStatic = opts.staticDocs?.[did];
      if (fromStatic) doc = fromStatic;
      else if (did.startsWith('did:key:')) doc = didKeyDocument(did);
      else if (did.startsWith('did:web:')) {
        doc = (await webFetch(didWebToUrl(did))) as DidDocument;
        if (!doc || typeof doc !== 'object' || doc.id !== did) throw new Error(`DID document id does not match ${did}.`);
      } else throw new Error(`Unsupported DID method: ${did}`);
      cache.set(did, doc);
      return doc;
    },
  };
}
