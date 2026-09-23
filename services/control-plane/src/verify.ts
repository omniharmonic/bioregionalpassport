import { createResolver, randomNonce, verifyDocument, type DataIntegrityProof, type DidResolver } from '@passport/credential-core';
import type { Db } from '@passport/db';
import { pendingMigrations, podSchema, withPod } from '@passport/db';
import type { TrustPolicy } from '@passport/tenant-config';
import type { PodContext } from './kit.js';
import { didDocumentFor, getPod, loadPodSigner, type PodSigner } from './pods.js';

export interface VerifyCheck {
  name: string;
  ok: boolean;
  /** True when an optional dependency was absent; skipped checks count as passing. */
  skipped?: boolean;
  detail?: string;
}

export interface VerifyReport {
  ok: boolean;
  slug: string;
  did?: string;
  /** Number of checks skipped because an optional dependency or module was absent. */
  skipped: number;
  startedAt: string;
  finishedAt: string;
  checks: VerifyCheck[];
}

/**
 * Helpers handed to optional smoke hooks so they can sign as the pod and resolve its DID offline.
 * The signer never exposes the private key.
 */
export interface SmokeHelpers {
  signer: PodSigner;
  resolver: DidResolver;
}

/**
 * Optional service deps, duck-typed so the smoke works incrementally as services land:
 * - `vta.ceremonyBackHalf(ctx, helpers)` (Task 8)
 * - `gateway.smokeTransfer(ctx, helpers)` — open two accounts and transfer 1 credit (Task 14)
 * - `appview.smokeRecord(ctx, helpers)` — insert one record and read it back (Task 10)
 * Each may return `{ ok, detail? }` (or anything truthy) and should throw on failure.
 */
export interface VerifyDeps {
  vta?: any;
  gateway?: any;
  appview?: any;
}

export interface VerifyInput {
  db: Db;
  slug: string;
  platformDomain: string;
  masterKey: string;
  deps?: VerifyDeps;
  now?: () => Date;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function runOptional(
  name: string,
  dep: any,
  fnName: string,
  enabled: { on: boolean; why?: string },
  run: (fn: (...args: any[]) => Promise<any>) => Promise<any>,
): Promise<VerifyCheck> {
  if (!enabled.on) return { name, ok: true, skipped: true, detail: enabled.why ?? 'module disabled' };
  if (!dep) return { name, ok: true, skipped: true, detail: 'dependency not provided' };
  const fn = dep[fnName];
  if (typeof fn !== 'function') return { name, ok: true, skipped: true, detail: `dependency has no ${fnName} helper` };
  try {
    const res = await run(fn.bind(dep));
    if (res && typeof res === 'object' && 'ok' in res) {
      return { name, ok: Boolean(res.ok), ...(res.detail ? { detail: String(res.detail) } : {}) };
    }
    return { name, ok: true };
  } catch (e) {
    return { name, ok: false, detail: errMsg(e) };
  }
}

/** Re-runs the pod smoke (B2 §5.1 step 9). Records a `platform.tenant_zero_runs` row for tenant zero. */
export async function verifyPod(input: VerifyInput): Promise<VerifyReport> {
  const { db, slug, platformDomain, masterKey } = input;
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const checks: VerifyCheck[] = [];
  const pod = await getPod(db, slug);

  if (!pod) {
    checks.push({ name: 'pod', ok: false, detail: `Pod ${slug} is not provisioned.` });
  } else {
    let signer: PodSigner | undefined;
    let resolver: DidResolver | undefined;

    // DID document resolves and the pod key signs a verifiable probe.
    try {
      const doc = await didDocumentFor(db, slug, platformDomain);
      if (!doc) throw new Error('The pod has no DID document (no key).');
      if (doc.id !== pod.did) throw new Error(`DID document id ${doc.id} does not match the pod DID ${pod.did}.`);
      resolver = createResolver({
        staticDocs: { [doc.id]: doc },
        webFetch: async (url) => {
          throw new Error(`no network in verify (refused to fetch ${url})`);
        },
      });
      signer = await loadPodSigner(db, slug, masterKey);
      const probe = signer.sign({ type: 'org.bioregion.controlPlane.probe', pod: pod.did, nonce: randomNonce() });
      const res = await verifyDocument(probe, resolver);
      checks.push(res.ok ? { name: 'did-document', ok: true, detail: doc.id } : { name: 'did-document', ok: false, detail: res.error });
    } catch (e) {
      checks.push({ name: 'did-document', ok: false, detail: errMsg(e) });
    }

    const verifySigned = async (name: string, doc: unknown): Promise<VerifyCheck> => {
      if (!resolver) return { name, ok: false, detail: 'No resolver: the DID document check failed.' };
      if (!doc || typeof doc !== 'object' || !(doc as { proof?: unknown }).proof) return { name, ok: false, detail: 'Document is not signed.' };
      const res = await verifyDocument(doc as { proof: DataIntegrityProof }, resolver);
      if (!res.ok) return { name, ok: false, detail: res.error };
      if (res.controller !== pod.did) return { name, ok: false, detail: `Signed by ${res.controller}, not the pod.` };
      return { name, ok: true };
    };
    checks.push(await verifySigned('manifest-signature', pod.manifest));
    checks.push(pod.policy ? await verifySigned('policy-signature', pod.policy) : { name: 'policy-signature', ok: false, detail: 'No trust policy.' });

    try {
      const pending = await pendingMigrations(db, podSchema(slug));
      checks.push(pending.length === 0 ? { name: 'schema', ok: true } : { name: 'schema', ok: false, detail: `pending: ${pending.join(', ')}` });
    } catch (e) {
      checks.push({ name: 'schema', ok: false, detail: errMsg(e) });
    }

    const deps = input.deps ?? {};
    const helpers = signer && resolver ? ({ signer, resolver } satisfies SmokeHelpers) : undefined;
    const inPod = (fn: (...args: any[]) => Promise<any>) =>
      withPod(db, slug, (tx) => {
        const ctx: PodContext = {
          slug,
          podDid: pod.did,
          db: tx,
          manifest: pod.manifest,
          policy: pod.policy as TrustPolicy,
          now,
          platformDomain,
        };
        return fn(ctx, helpers);
      });
    const ready = helpers ? { on: true } : { on: false, why: 'pod signer unavailable' };
    checks.push(await runOptional('vta-ceremony', deps.vta, 'ceremonyBackHalf', ready, inPod));
    checks.push(
      await runOptional(
        'ledger-transfer',
        deps.gateway,
        'smokeTransfer',
        helpers ? (pod.manifest.modules.circulation ? ready : { on: false, why: 'circulation module disabled' }) : ready,
        inPod,
      ),
    );
    checks.push(await runOptional('appview-record', deps.appview, 'smokeRecord', ready, inPod));
  }

  const finishedAt = now().toISOString();
  const report: VerifyReport = {
    ok: checks.every((c) => c.ok),
    slug,
    skipped: checks.filter((c) => c.skipped).length,
    ...(pod ? { did: pod.did } : {}),
    startedAt,
    finishedAt,
    checks,
  };
  if (slug === 'tenant-zero') {
    await db.query('insert into platform.tenant_zero_runs (started_at, finished_at, ok, report) values ($1, $2, $3, $4)', [
      startedAt,
      finishedAt,
      report.ok,
      JSON.stringify(report),
    ]);
  }
  return report;
}
