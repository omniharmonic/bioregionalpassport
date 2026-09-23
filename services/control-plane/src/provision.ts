import { generateKeyPair } from '@passport/credential-core';
import type { Db } from '@passport/db';
import { migratePod, pendingMigrations, podSchema, withPod } from '@passport/db';
import {
  defaultTrustPolicy,
  manifestHash,
  validateManifest,
  type BioregionManifest,
  type TrustPolicy,
} from '@passport/tenant-config';
import { VOCAB_VERSION } from '@passport/vocab';
import { ServiceError, type PodContext } from './kit.js';
import { encryptPrivateKey } from './keys.js';
import { latestPolicy, loadPodSigner, podDid, podKeyRow, podRow, policyUrl, type PodRow } from './pods.js';

export type StepStatus = 'created' | 'unchanged' | 'updated';

export interface ProvisionStep {
  name: string;
  status: StepStatus;
  detail?: string;
}

export interface ProvisionResult {
  slug: string;
  did: string;
  /** Signed manifest as stored in `platform.pods`. */
  manifest: BioregionManifest;
  steps: ProvisionStep[];
}

export interface ProvisionDeps {
  /**
   * Seeds demo open records (appview, Task 10), inside `withPod`. The step status is derived from the
   * `records` row count before/after, so an idempotent seeder reports `unchanged` on re-runs.
   */
  seedRecords?: (ctx: PodContext) => Promise<void | { detail?: string }>;
}

export interface ProvisionInput {
  manifest: unknown;
  db: Db;
  platformDomain: string;
  /** `POD_KEY_ENCRYPTION_KEY`, 64 hex chars. */
  masterKey: string;
  now?: () => Date;
  deps?: ProvisionDeps;
  /** Allow a manifest that removes existing `governance.anchors` or lowers `$schema` (default false). */
  allowDowngrade?: boolean;
  /**
   * Create-only mode (`POST /pods`): refuse with 409 `POD_EXISTS` when the pod is already active
   * and the manifest differs. Re-running with an identical manifest is still a no-op.
   */
  refuseUpdate?: boolean;
}

/** `https://bioregion.org/schemas/manifest/v1.2` → `[1, 2]` (missing parts are 0). */
export function schemaVersion(schema: string): number[] {
  const m = schema.match(/\/v(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [0, 0, 0];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Turns a manifest into a working pod (B2 §5.1 adapted for MVP). Idempotent: re-running with the
 * same manifest yields the same DID and every step reports `unchanged`.
 */
export async function provisionPod(input: ProvisionInput): Promise<ProvisionResult> {
  const { db, platformDomain, masterKey } = input;
  const now = input.now ?? (() => new Date());
  const steps: ProvisionStep[] = [];

  // 1. validate ---------------------------------------------------------------------------
  const validated = validateManifest(input.manifest);
  if (!validated.ok) {
    throw new ServiceError(400, 'INVALID_MANIFEST', `The manifest is not valid: ${validated.errors.join('; ')}.`);
  }
  const slug = validated.manifest.identity.slug;
  podSchema(slug); // throws on an unusable slug
  const did = podDid(platformDomain, slug);
  const { proof: _oldProof, ...incoming } = validated.manifest;
  const unsigned: BioregionManifest = {
    ...incoming,
    identity: { ...incoming.identity, did },
    trustPolicy: policyUrl(slug, platformDomain),
  };
  const notes: string[] = [];
  if (incoming.identity.did !== did) notes.push(`identity.did ${incoming.identity.did} replaced by ${did} (the platform hosts the DID document)`);
  const hash = manifestHash(unsigned);

  // Guards against clobbering an existing pod (before anything is written).
  let pod = await podRow(db, slug);
  let removedAnchors: string[] = [];
  let schemaLowered = false;
  if (pod && pod.status === 'active' && pod.manifest_hash && pod.manifest_hash !== hash) {
    if (input.refuseUpdate) {
      throw new ServiceError(
        409,
        'POD_EXISTS',
        `This pod already exists; use PUT /pods/${slug}/manifest to update it.`,
      );
    }
    const oldAnchors = pod.manifest.governance?.anchors ?? [];
    removedAnchors = oldAnchors.filter((a) => !unsigned.governance.anchors.includes(a));
    schemaLowered = compareVersions(schemaVersion(unsigned.$schema), schemaVersion(pod.manifest.$schema)) < 0;
    if ((removedAnchors.length > 0 || schemaLowered) && !input.allowDowngrade) {
      const reasons = [
        ...(removedAnchors.length ? [`removes anchor(s) ${removedAnchors.join(', ')}`] : []),
        ...(schemaLowered ? [`lowers $schema from ${pod.manifest.$schema} to ${unsigned.$schema}`] : []),
      ];
      throw new ServiceError(
        409,
        'DOWNGRADE_REFUSED',
        `This manifest ${reasons.join(' and ')}, which would downgrade pod ${slug}.`,
        'Re-run with allowDowngrade (CLI --allow-downgrade) if this is intended.',
      );
    }
  }
  steps.push({ name: 'validate', status: 'unchanged', ...(notes.length ? { detail: notes.join('; ') } : {}) });

  // 2. pod-key ----------------------------------------------------------------------------
  if (!pod) {
    // Placeholder row: pod_keys references pods(slug). Completed in the manifest step.
    await db.query(
      "insert into platform.pods (slug, did, name, manifest, status) values ($1, $2, $3, $4, 'provisioning') on conflict (slug) do nothing",
      [slug, did, unsigned.identity.name, JSON.stringify(unsigned)],
    );
    pod = await podRow(db, slug);
  } else if (pod.did !== did) {
    throw new ServiceError(
      409,
      'DID_MISMATCH',
      `Pod ${slug} is already provisioned as ${pod.did}, not ${did}.`,
      'Use the same PLATFORM_DOMAIN the pod was first provisioned with.',
    );
  }
  const key = await podKeyRow(db, slug);
  let keyCreated = false;
  if (!key) {
    const fresh = generateKeyPair();
    const kid = `${did}#key-1`;
    const encrypted = await encryptPrivateKey(fresh.privateKey, masterKey, `${slug}|${kid}`);
    await db.query(
      'insert into platform.pod_keys (slug, kid, public_key_multibase, encrypted_private_key) values ($1, $2, $3, $4) on conflict do nothing',
      [slug, kid, fresh.publicKeyMultibase, encrypted],
    );
    keyCreated = true;
    steps.push({ name: 'pod-key', status: 'created', detail: kid });
  } else {
    steps.push({ name: 'pod-key', status: 'unchanged', detail: key.kid });
  }
  // Decrypting here fails fast (with a clear message) when the master key is wrong.
  const signer = await loadPodSigner(db, slug, masterKey);

  // 3. did-document -----------------------------------------------------------------------
  steps.push({
    name: 'did-document',
    status: keyCreated ? 'created' : 'unchanged',
    detail: `https://${platformDomain}/dids/${slug}/did.json`,
  });

  // 4. schema -----------------------------------------------------------------------------
  const schema = podSchema(slug);
  const schemaExisted =
    (await db.query('select 1 from information_schema.schemata where schema_name = $1', [schema])).length > 0;
  const pending = schemaExisted ? await pendingMigrations(db, schema) : [];
  await migratePod(db, slug);
  if (!schemaExisted) steps.push({ name: 'schema', status: 'created', detail: schema });
  else if (pending.length > 0) steps.push({ name: 'schema', status: 'updated', detail: `applied ${pending.join(', ')}` });
  else steps.push({ name: 'schema', status: 'unchanged', detail: schema });

  // 5. trust-policy -----------------------------------------------------------------------
  const policyCreated = await withPod(db, slug, async (tx) => {
    const rows = await tx.query<{ n: number }>('select count(*)::int as n from policy_versions');
    if ((rows[0]?.n ?? 0) > 0) return false;
    const at = now();
    const signed = signer.sign(defaultTrustPolicy(did), { created: at.toISOString() });
    await tx.query('insert into policy_versions (version, policy, signed_at) values ($1, $2, $3)', [
      signed.version,
      JSON.stringify(signed),
      at.toISOString(),
    ]);
    return true;
  });
  steps.push({ name: 'trust-policy', status: policyCreated ? 'created' : 'unchanged', ...(policyCreated ? { detail: 'version 1' } : {}) });

  // 6. manifest + 7. registry -------------------------------------------------------------
  // One transaction: the pods upsert, its manifest_versions row and the registry entry commit
  // together, so a failure can never leave a new manifest_hash without its history row (which
  // later runs would read as "unchanged" and never record). The pods row is locked to serialize
  // concurrent provisions of the same slug.
  const { signedManifest, manifestStep, registryStep } = await db.transaction(async (tx) => {
    const current = (
      await tx.query<PodRow>(
        'select slug, did, name, manifest, manifest_hash, status from platform.pods where slug = $1 for update',
        [slug],
      )
    )[0];
    let signedManifest: BioregionManifest;
    let manifestStep: ProvisionStep;
    if (current && current.manifest_hash === hash && current.status === 'active' && current.manifest.proof) {
      signedManifest = current.manifest;
      manifestStep = { name: 'manifest', status: 'unchanged', detail: hash };
    } else {
      const firstTime = !current?.manifest_hash;
      const signedAt = now().toISOString();
      signedManifest = signer.sign(unsigned, { created: signedAt }) as BioregionManifest;
      await tx.query(
        `insert into platform.pods (slug, did, name, manifest, manifest_hash, status, updated_at)
         values ($1, $2, $3, $4, $5, 'active', now())
         on conflict (slug) do update set did = excluded.did, name = excluded.name, manifest = excluded.manifest,
           manifest_hash = excluded.manifest_hash, status = 'active', updated_at = now()`,
        [slug, did, signedManifest.identity.name, JSON.stringify(signedManifest), hash],
      );
      const versionRows = await tx.query<{ v: number }>(
        'insert into platform.manifest_versions (slug, version, manifest, manifest_hash, signed_at) ' +
          'select $1, coalesce(max(version), 0) + 1, $2, $3, $4 from platform.manifest_versions where slug = $1 returning version as v',
        [slug, JSON.stringify(signedManifest), hash, signedAt],
      );
      const downgrade = [
        ...(removedAnchors.length ? [`removed anchors: ${removedAnchors.join(', ')}`] : []),
        ...(schemaLowered ? ['$schema lowered'] : []),
      ];
      manifestStep = {
        name: 'manifest',
        status: firstTime ? 'created' : 'updated',
        detail: [`version ${versionRows[0]?.v ?? '?'}`, hash, ...downgrade].join('; '),
      };
    }

    const entry = {
      did,
      anchors: signedManifest.governance.anchors,
      accepted_issuers: [did],
      vocab_version: String(VOCAB_VERSION),
    };
    const existing = (
      await tx.query<{ did: string; anchors: string[]; accepted_issuers: string[]; vocab_version: string | null }>(
        'select did, anchors, accepted_issuers, vocab_version from platform.registry_entries where slug = $1',
        [slug],
      )
    )[0];
    let registryStep: ProvisionStep;
    if (
      existing &&
      existing.did === entry.did &&
      sameJson(existing.anchors, entry.anchors) &&
      sameJson(existing.accepted_issuers, entry.accepted_issuers) &&
      existing.vocab_version === entry.vocab_version
    ) {
      registryStep = { name: 'registry', status: 'unchanged' };
    } else {
      await tx.query(
        `insert into platform.registry_entries (slug, did, anchors, accepted_issuers, vocab_version, updated_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (slug) do update set did = excluded.did, anchors = excluded.anchors,
           accepted_issuers = excluded.accepted_issuers, vocab_version = excluded.vocab_version, updated_at = now()`,
        [slug, entry.did, JSON.stringify(entry.anchors), JSON.stringify(entry.accepted_issuers), entry.vocab_version],
      );
      registryStep = { name: 'registry', status: existing ? 'updated' : 'created' };
    }
    return { signedManifest, manifestStep, registryStep };
  });
  steps.push(manifestStep, registryStep);

  // 8. seed-records -----------------------------------------------------------------------
  if (input.deps?.seedRecords) {
    const policy = (await latestPolicy(db, slug)) as TrustPolicy;
    const seedRecords = input.deps.seedRecords;
    const count = async (tx: Db) => (await tx.query<{ n: number }>('select count(*)::int as n from records'))[0]?.n ?? 0;
    const { before, after, res } = await withPod(db, slug, async (tx) => {
      const before = await count(tx);
      const res = await seedRecords({ slug, podDid: did, db: tx, manifest: signedManifest, policy, now, platformDomain });
      return { before, after: await count(tx), res };
    });
    const status: StepStatus = after === before ? 'unchanged' : before === 0 ? 'created' : 'updated';
    steps.push({ name: 'seed-records', status, detail: res?.detail ?? `${after} records (${after - before} new)` });
  } else {
    steps.push({ name: 'seed-records', status: 'unchanged', detail: 'no seeder configured' });
  }

  return { slug, did, manifest: signedManifest, steps };
}
