import type { Db } from '@passport/db';
import { migratePlatform } from '@passport/db';
import { tenantZeroManifest } from '@passport/tenant-config';
import { ServiceError, type PlatformContext, type Route } from './kit.js';
import { exportPod } from './export.js';
import { podRow } from './pods.js';
import { provisionPod, type ProvisionDeps, type ProvisionResult } from './provision.js';
import { verifyPod, type VerifyDeps, type VerifyReport } from './verify.js';

export interface ControlRouteOptions {
  /** Overrides `ctx.masterKey`. */
  masterKey?: string;
  provisionDeps?: ProvisionDeps;
  verifyDeps?: VerifyDeps;
}

function requireMasterKey(ctx: PlatformContext, opts: ControlRouteOptions): string {
  const key = opts.masterKey ?? ctx.masterKey;
  if (!key) throw new ServiceError(500, 'NO_MASTER_KEY', 'The control plane has no POD_KEY_ENCRYPTION_KEY configured.');
  return key;
}

async function requirePod(db: Db, slug: string): Promise<void> {
  if (!(await podRow(db, slug))) throw new ServiceError(404, 'POD_NOT_FOUND', `No pod is provisioned as ${slug}.`);
}

/** Operator-only control plane routes (mounted under `/api/control`). */
export function createControlRoutes(opts: ControlRouteOptions = {}): Route<PlatformContext>[] {
  const provision = (ctx: PlatformContext, manifest: unknown, flags: { refuseUpdate?: boolean; allowDowngrade?: boolean } = {}) =>
    provisionPod({
      manifest,
      ...flags,
      db: ctx.db,
      platformDomain: ctx.platformDomain,
      masterKey: requireMasterKey(ctx, opts),
      ...(ctx.now ? { now: ctx.now } : {}),
      ...(opts.provisionDeps ? { deps: opts.provisionDeps } : {}),
    });
  return [
    {
      method: 'POST',
      path: '/pods',
      auth: 'operator',
      handler: async (ctx, req) => {
        const result = await provision(ctx, req.body, { refuseUpdate: true });
        const created = result.steps.some((s) => s.name === 'manifest' && s.status === 'created');
        return { status: created ? 201 : 200, body: result };
      },
    },
    {
      method: 'PUT',
      path: '/pods/:slug/manifest',
      auth: 'operator',
      handler: async (ctx, req) => {
        const slug = req.params['slug'] ?? '';
        await requirePod(ctx.db, slug);
        const bodySlug = req.body?.identity?.slug;
        if (bodySlug !== slug) {
          throw new ServiceError(400, 'SLUG_MISMATCH', `The manifest is for ${String(bodySlug)}, not ${slug}.`, 'A pod slug cannot be changed.');
        }
        const allowDowngrade = ['1', 'true', 'yes'].includes(String(req.query['allowDowngrade'] ?? '').toLowerCase());
        return { body: await provision(ctx, req.body, { allowDowngrade }) };
      },
    },
    {
      method: 'POST',
      path: '/pods/:slug/verify',
      auth: 'operator',
      handler: async (ctx, req) => {
        const slug = req.params['slug'] ?? '';
        await requirePod(ctx.db, slug);
        const report = await verifyPod({
          db: ctx.db,
          slug,
          platformDomain: ctx.platformDomain,
          masterKey: requireMasterKey(ctx, opts),
          ...(opts.verifyDeps ? { deps: opts.verifyDeps } : {}),
          ...(ctx.now ? { now: ctx.now } : {}),
        });
        return { body: report };
      },
    },
    {
      method: 'GET',
      path: '/pods/:slug/export',
      auth: 'operator',
      handler: async (ctx, req) => {
        const slug = req.params['slug'] ?? '';
        await requirePod(ctx.db, slug);
        return { body: await exportPod(ctx.db, slug) };
      },
    },
  ];
}

export interface TenantZeroReport {
  ok: boolean;
  provision: ProvisionResult;
  verify: VerifyReport;
}

/** CI job: provision tenant zero (idempotent) and run the smoke; the verify run is recorded in `platform.tenant_zero_runs`. */
export async function tenantZeroJob(
  db: Db,
  platformDomain: string,
  masterKey: string,
  deps?: VerifyDeps & ProvisionDeps,
): Promise<TenantZeroReport> {
  await migratePlatform(db);
  const provision = await provisionPod({
    manifest: tenantZeroManifest,
    db,
    platformDomain,
    masterKey,
    ...(deps?.seedRecords ? { deps: { seedRecords: deps.seedRecords } } : {}),
  });
  const verify = await verifyPod({
    db,
    slug: provision.slug,
    platformDomain,
    masterKey,
    ...(deps ? { deps: { vta: deps.vta, gateway: deps.gateway, appview: deps.appview } } : {}),
  });
  return { ok: verify.ok, provision, verify };
}
