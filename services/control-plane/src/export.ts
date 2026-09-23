import type { DidDocument } from '@passport/credential-core';
import type { Db } from '@passport/db';
import { podSchema, quoteIdent } from '@passport/db';
import type { BioregionManifest, TrustPolicy } from '@passport/tenant-config';
import { domainFromDid, getPod, podDidDocument, podKeyRow } from './pods.js';

export interface PodExport {
  manifest: BioregionManifest;
  didDocument: DidDocument | null;
  policy: TrustPolicy | null;
  tables: Record<string, Record<string, unknown>[]>;
}

/** JSON-safe copy: bigint → string, Date → ISO string. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

/** Full pod bundle for exit/portability: signed manifest, DID document, policy and every pod table. */
export async function exportPod(db: Db, slug: string): Promise<PodExport> {
  const pod = await getPod(db, slug);
  if (!pod) throw new Error(`Pod ${slug} is not provisioned.`);
  const key = await podKeyRow(db, slug);
  const didDocument = key ? podDidDocument(pod.did, slug, key.public_key_multibase, domainFromDid(pod.did)) : null;
  const schema = podSchema(slug);
  const names = await db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by table_name",
    [schema],
  );
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const { table_name } of names) {
    const rows = await db.query<Record<string, unknown>>(`select * from ${quoteIdent(schema)}.${quoteIdent(table_name)}`);
    tables[table_name] = rows.map((r) => jsonSafe(r) as Record<string, unknown>);
  }
  return { manifest: pod.manifest, didDocument, policy: pod.policy, tables };
}
