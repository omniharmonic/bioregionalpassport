/**
 * `GET /api/control/health` — operator-only aggregate health for the operator console.
 *
 * Not part of `createControlRoutes` (services/control-plane is out of scope for Task
 * 15), so it is a plain Next.js route handler that borrows the same Bearer-only
 * operator check `mountService`'s `checkAuth` applies to platform-scope `operator`
 * routes (see `apps/web/lib/operatorAuth.ts`).
 *
 * `GET /api/control/health` (no `slug`) returns a summary per pod (counts only, no
 * manifest/policy) plus platform-wide numbers — cheap enough for the pod list.
 * `GET /api/control/health?slug=<slug>` returns that one pod's manifest and signed
 * policy too, for the per-pod console.
 */
import { getPod } from '@passport/control-plane';
import { listPods, pendingMigrations, podSchema, sqlFiles, withPod } from '@passport/db';
import type { BioregionManifest, TrustPolicy } from '@passport/tenant-config';
import { db, jsonValue } from '@/lib/db';
import { env } from '@/lib/env';
import { OperatorAuthError, requireOperator } from '@/lib/operatorAuth';
import { isSlug } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

interface PodCounts {
  members: Record<string, number>;
  membersTotal: number;
  events: number;
}

async function podCounts(slug: string): Promise<PodCounts> {
  return withPod(db(), slug, async (tx) => {
    const tiers = await tx.query<{ tier: string; n: number }>('select tier, count(*)::int as n from members group by tier order by tier');
    const events = await tx.query<{ n: number }>('select count(*)::int as n from events');
    const members = Object.fromEntries(tiers.map((r) => [r.tier, Number(r.n)]));
    const membersTotal = Object.values(members).reduce((a, b) => a + b, 0);
    return { members, membersTotal, events: Number(events[0]?.n ?? 0) };
  });
}

interface PodHealthSummary {
  slug: string;
  did: string;
  name: string;
  status: string;
  members: Record<string, number>;
  membersTotal: number;
  events: number;
  pendingMigrations: string[];
  error?: string;
}

async function summaryFor(slug: string): Promise<PodHealthSummary | null> {
  const pod = await getPod(db(), slug);
  if (!pod) return null;
  const name = jsonValue<BioregionManifest>(pod.manifest).identity.name;
  try {
    const [counts, pending] = await Promise.all([podCounts(slug), pendingMigrations(db(), podSchema(slug))]);
    return { slug, did: pod.did, name, status: pod.status, pendingMigrations: pending, ...counts };
  } catch (err) {
    console.error(`[control/health] summary for ${slug}`, err);
    return { slug, did: pod.did, name, status: pod.status, members: {}, membersTotal: 0, events: 0, pendingMigrations: [], error: 'Health numbers are not available for this pod.' };
  }
}

interface PodHealthDetail extends PodHealthSummary {
  manifest: BioregionManifest;
  policy: TrustPolicy | null;
}

async function detailFor(slug: string): Promise<PodHealthDetail | null> {
  const pod = await getPod(db(), slug);
  if (!pod) return null;
  const manifest = jsonValue<BioregionManifest>(pod.manifest);
  const policy = pod.policy === null ? null : jsonValue<TrustPolicy>(pod.policy);
  const name = manifest.identity.name;
  try {
    const [counts, pending] = await Promise.all([podCounts(slug), pendingMigrations(db(), podSchema(slug))]);
    return { slug, did: pod.did, name, status: pod.status, manifest, policy, pendingMigrations: pending, ...counts };
  } catch (err) {
    console.error(`[control/health] detail for ${slug}`, err);
    return {
      slug,
      did: pod.did,
      name,
      status: pod.status,
      manifest,
      policy,
      members: {},
      membersTotal: 0,
      events: 0,
      pendingMigrations: [],
      error: 'Health numbers are not available for this pod.',
    };
  }
}

interface TenantZeroRunRow {
  id: number | string;
  started_at: unknown;
  finished_at: unknown;
  ok: boolean | null;
  report: unknown;
}

async function lastTenantZeroRun() {
  const rows = await db().query<TenantZeroRunRow>('select id, started_at, finished_at, ok, report from platform.tenant_zero_runs order by id desc limit 1');
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    startedAt: row.started_at ? new Date(row.started_at as string).toISOString() : null,
    finishedAt: row.finished_at ? new Date(row.finished_at as string).toISOString() : null,
    ok: row.ok,
    report: row.report === undefined ? null : jsonValue(row.report),
  };
}

export async function GET(req: Request) {
  try {
    requireOperator(req, env().OPERATOR_TOKEN);

    const url = new URL(req.url);
    const slug = url.searchParams.get('slug');
    const [platformPending, files, lastRun] = await Promise.all([pendingMigrations(db(), 'platform'), sqlFiles(), lastTenantZeroRun()]);
    const platform = { pendingMigrations: platformPending, platformMigrationFiles: files.platform.length };

    if (slug !== null) {
      if (!isSlug(slug)) return json(400, { code: 'BAD_REQUEST', message: 'slug must match /^[a-z0-9-]{2,40}$/.' });
      const pod = await detailFor(slug);
      if (!pod) return json(404, { code: 'POD_NOT_FOUND', message: `No pod is provisioned as ${slug}.` });
      return json(200, { ok: true, platform, lastTenantZeroRun: lastRun, pod });
    }

    const pods = await listPods(db());
    const summaries = (await Promise.all(pods.map((p) => summaryFor(p.slug)))).filter((p): p is PodHealthSummary => p !== null);
    return json(200, { ok: platformPending.length === 0 && files.platform.length > 0, platform, lastTenantZeroRun: lastRun, pods: summaries });
  } catch (err) {
    if (err instanceof OperatorAuthError) {
      return json(err.status, { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) });
    }
    console.error('[control/health]', err);
    return json(500, { code: 'INTERNAL', message: 'The platform database is not reachable right now.' });
  }
}
