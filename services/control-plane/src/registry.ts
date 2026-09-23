import type { Db } from '@passport/db';
import { manifestUrl } from '@passport/tenant-config';
import { ServiceError, type PlatformContext, type Route } from './kit.js';
import { getPod, podCard, domainFromDid } from './pods.js';

/** Authorities a registered pod DID is recognised for (TRQP `authorization`). */
export const POD_ISSUER_AUTHORITIES = [
  'issue:MembershipCredential',
  'issue:AuthorityCredential',
  'issue:StatementCredential:witnessed',
  'issue:DelegationCredential',
] as const;

export interface RegistryEntry {
  slug: string;
  did: string;
  name: string;
  anchors: string[];
  acceptedIssuers: string[];
  vocabVersion: string | null;
}

export async function registryEntries(db: Db): Promise<RegistryEntry[]> {
  const rows = await db.query<{ slug: string; did: string; name: string; anchors: string[]; accepted_issuers: string[]; vocab_version: string | null }>(
    `select r.slug, r.did, p.name, r.anchors, r.accepted_issuers, r.vocab_version
       from platform.registry_entries r join platform.pods p on p.slug = r.slug
      where p.status = 'active' order by r.slug`,
  );
  return rows.map((r) => ({
    slug: r.slug,
    did: r.did,
    name: r.name,
    anchors: r.anchors ?? [],
    acceptedIssuers: r.accepted_issuers ?? [],
    vocabVersion: r.vocab_version,
  }));
}

/** TRQP v2.0 authorization query: is `entity` authorized for `authority` (optionally within pod `context`)? */
export async function authorize(
  db: Db,
  q: { entity: string; authority: string; context?: string },
): Promise<{ authorized: boolean; reason: string }> {
  const all = await registryEntries(db);
  let scope = all;
  if (q.context) {
    scope = all.filter((e) => e.did === q.context || e.slug === q.context);
    if (scope.length === 0) return { authorized: false, reason: `${q.context} is not a registered pod.` };
  }
  if (q.authority === 'anchor') {
    const hit = scope.find((e) => e.anchors.includes(q.entity));
    return hit
      ? { authorized: true, reason: `${q.entity} is an anchor of ${hit.slug}.` }
      : { authorized: false, reason: `${q.entity} is not listed as an anchor${q.context ? ` of ${q.context}` : ' of any registered pod'}.` };
  }
  if (!(POD_ISSUER_AUTHORITIES as readonly string[]).includes(q.authority)) {
    return { authorized: false, reason: `${q.authority} is not an authority the registry recognises.` };
  }
  const hit = scope.find((e) => e.did === q.entity || (q.context !== undefined && e.acceptedIssuers.includes(q.entity)));
  return hit
    ? { authorized: true, reason: `${q.entity} is the registered pod ${hit.slug} and may ${q.authority}.` }
    : { authorized: false, reason: `${q.entity} is not a registered pod${q.context ? ` or accepted issuer of ${q.context}` : ''}.` };
}

const one = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** Platform-level TRQP registry routes (mounted under `/api/registry`). */
export function createRegistryRoutes(): Route<PlatformContext>[] {
  return [
    {
      method: 'GET',
      path: '/authorization',
      auth: 'none',
      handler: async (ctx, req) => {
        const entity = one(req.query['entity']);
        const authority = one(req.query['authority']);
        const context = one(req.query['context']);
        if (!entity || !authority) {
          throw new ServiceError(400, 'BAD_REQUEST', 'The authorization query needs both entity and authority.', 'Example: ?entity=did:web:…&authority=issue:MembershipCredential');
        }
        return { body: await authorize(ctx.db, { entity, authority, ...(context ? { context } : {}) }) };
      },
    },
    {
      method: 'GET',
      path: '/recognition',
      auth: 'none',
      handler: async (ctx) => {
        const pods = (await registryEntries(ctx.db)).map((e) => ({
          slug: e.slug,
          did: e.did,
          anchors: e.anchors,
          acceptedIssuers: e.acceptedIssuers,
          manifestUrl: manifestUrl(e.slug, ctx.platformDomain ?? domainFromDid(e.did)),
        }));
        return { body: { pods } };
      },
    },
    {
      method: 'GET',
      path: '/pods',
      auth: 'none',
      handler: async (ctx) => {
        const pods = (await registryEntries(ctx.db)).map((e) => ({
          slug: e.slug,
          did: e.did,
          acceptedIssuers: e.acceptedIssuers,
          manifestUrl: manifestUrl(e.slug, ctx.platformDomain ?? domainFromDid(e.did)),
        }));
        return { body: { pods } };
      },
    },
    {
      method: 'GET',
      path: '/pods/:slug',
      auth: 'none',
      handler: async (ctx, req) => {
        const slug = req.params['slug'] ?? '';
        const pod = await getPod(ctx.db, slug);
        if (!pod || pod.status !== 'active') throw new ServiceError(404, 'POD_NOT_FOUND', `No active pod is registered as ${slug}.`);
        return { body: { card: podCard({ slug: pod.slug, did: pod.did, name: pod.manifest.identity.name }, ctx.platformDomain), manifest: pod.manifest } };
      },
    },
  ];
}
