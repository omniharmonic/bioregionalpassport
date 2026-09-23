import {
  didWebDocument,
  didWebFromDomainPath,
  keyPairForDid,
  signDocument,
  type DataIntegrityProof,
  type DidDocument,
  type KeyPair,
} from '@passport/credential-core';
import type { Db } from '@passport/db';
import { podSchema, quoteIdent } from '@passport/db';
import { manifestUrl, type BioregionManifest, type TrustPolicy } from '@passport/tenant-config';
import type { PodRecord } from '@passport/lexicons';
import { decryptPrivateKey } from './keys.js';

export const DEFAULT_PLATFORM_DOMAIN = 'bioregionalpassport.org';

export interface PodKeyRow {
  slug: string;
  kid: string;
  public_key_multibase: string;
  encrypted_private_key: string;
}

export interface PodRow {
  slug: string;
  did: string;
  name: string;
  manifest: BioregionManifest;
  manifest_hash: string | null;
  status: string;
}

/** `did:web:<domain>:dids:<slug>` — the platform hosts every pod DID document (ADR-21). */
export const podDid = (platformDomain: string, slug: string): string => didWebFromDomainPath(platformDomain, 'dids', slug);

/** Platform domain encoded in a pod did:web (`did:web:example.org:dids:x` → `example.org`). */
export function domainFromDid(did: string): string {
  const host = did.startsWith('did:web:') ? did.slice('did:web:'.length).split(':')[0] : undefined;
  return host ? decodeURIComponent(host) : DEFAULT_PLATFORM_DOMAIN;
}

export const policyUrl = (slug: string, platformDomain: string): string => `https://${slug}.${platformDomain}/api/vta/policy`;

export async function podKeyRow(db: Db, slug: string): Promise<PodKeyRow | undefined> {
  const rows = await db.query<PodKeyRow>(
    'select slug, kid, public_key_multibase, encrypted_private_key from platform.pod_keys where slug = $1 order by created_at desc, kid desc limit 1',
    [slug],
  );
  return rows[0];
}

export async function podRow(db: Db, slug: string): Promise<PodRow | undefined> {
  const rows = await db.query<PodRow>(
    'select slug, did, name, manifest, manifest_hash, status from platform.pods where slug = $1',
    [slug],
  );
  return rows[0];
}

/** did:web document for a pod DID with a `BioregionManifest` service entry. */
export function podDidDocument(did: string, slug: string, publicKeyMultibase: string, platformDomain: string): DidDocument {
  const doc = didWebDocument(did, publicKeyMultibase);
  doc.service = [{ id: `${did}#manifest`, type: 'BioregionManifest', serviceEndpoint: manifestUrl(slug, platformDomain) }];
  return doc;
}

/**
 * The DID document served at `https://<platformDomain>/dids/<slug>/did.json`, or `null`
 * when the pod has no key yet. Nothing is stored: it is derived from `platform.pod_keys`.
 */
export async function didDocumentFor(db: Db, slug: string, platformDomain: string): Promise<DidDocument | null> {
  const key = await podKeyRow(db, slug);
  if (!key) return null;
  return podDidDocument(podDid(platformDomain, slug), slug, key.public_key_multibase, platformDomain);
}

export interface PodSigner {
  did: string;
  kid: string;
  publicKeyMultibase: string;
  /** The decrypted key bound to the pod DID, for builders that take a `KeyPair` (e.g. `attenuate`). */
  keyPair: KeyPair;
  sign<T extends object>(
    doc: T,
    opts?: { proofPurpose?: string; challenge?: string; domain?: string; created?: string },
  ): T & { proof: DataIntegrityProof };
}

/** Decrypts the pod key (ADR-27) and returns a signer bound to the pod DID. */
export async function loadPodSigner(db: Db, slug: string, masterKey: string): Promise<PodSigner> {
  const pod = await podRow(db, slug);
  if (!pod) throw new Error(`Pod ${slug} is not provisioned.`);
  const key = await podKeyRow(db, slug);
  if (!key) throw new Error(`Pod ${slug} has no signing key.`);
  const privateKey = await decryptPrivateKey(key.encrypted_private_key, masterKey, slug);
  const fragment = key.kid.includes('#') ? key.kid.slice(key.kid.indexOf('#') + 1) : 'key-1';
  const keyPair = keyPairForDid(pod.did, privateKey, fragment);
  if (keyPair.publicKeyMultibase !== key.public_key_multibase) {
    throw new Error(`The decrypted key for ${slug} does not match its published public key.`);
  }
  return {
    did: pod.did,
    kid: keyPair.kid,
    publicKeyMultibase: keyPair.publicKeyMultibase,
    keyPair,
    sign: (doc, opts) => signDocument(doc, keyPair, opts),
  };
}

/** Latest signed trust policy in the pod schema, or `null` when none is written yet. */
export async function latestPolicy(db: Db, slug: string): Promise<TrustPolicy | null> {
  const schema = quoteIdent(podSchema(slug));
  const exists = await db.query<{ n: number }>(
    "select count(*)::int as n from information_schema.tables where table_schema = $1 and table_name = 'policy_versions'",
    [podSchema(slug)],
  );
  if (!exists[0]?.n) return null;
  const rows = await db.query<{ policy: TrustPolicy }>(`select policy from ${schema}.policy_versions order by version desc limit 1`);
  return rows[0]?.policy ?? null;
}

export interface PodView {
  slug: string;
  did: string;
  manifest: BioregionManifest;
  policy: TrustPolicy | null;
  status: string;
}

export async function getPod(db: Db, slug: string): Promise<PodView | null> {
  const pod = await podRow(db, slug);
  if (!pod) return null;
  return { slug: pod.slug, did: pod.did, manifest: pod.manifest, policy: await latestPolicy(db, slug), status: pod.status };
}

export type PodCard = PodRecord & { $type: 'org.bioregion.pod' };

export function podCard(pod: { slug: string; did: string; name: string }, platformDomain?: string): PodCard {
  const domain = platformDomain ?? domainFromDid(pod.did);
  return {
    $type: 'org.bioregion.pod',
    bioregion: pod.slug,
    slug: pod.slug,
    name: pod.name,
    did: pod.did,
    manifestUrl: manifestUrl(pod.slug, domain),
    registryEntry: `https://${domain}/api/registry/pods/${pod.slug}`,
  };
}

/** `org.bioregion.pod` cards for every active pod (landing page). */
export async function listPodCards(db: Db, platformDomain?: string): Promise<PodCard[]> {
  const rows = await db.query<{ slug: string; did: string; name: string }>(
    "select slug, did, name from platform.pods where status = 'active' order by slug",
  );
  return rows.map((r) => podCard(r, platformDomain));
}
