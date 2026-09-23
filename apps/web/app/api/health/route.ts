import { listPods, pendingMigrations } from '@passport/db';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [pods, pending] = await Promise.all([listPods(db()), pendingMigrations(db(), 'platform')]);
    return Response.json(
      { ok: pending.length === 0, pods: pods.length, pendingPlatformMigrations: pending },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    console.error('[health]', err);
    return Response.json(
      { ok: false, code: 'UNHEALTHY', message: 'The platform database is not reachable or not migrated.' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
