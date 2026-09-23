import { listPods, pendingMigrations, sqlFiles } from '@passport/db';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [pods, pending, files] = await Promise.all([listPods(db()), pendingMigrations(db(), 'platform'), sqlFiles()]);
    // `platformMigrations` guards against a false "nothing pending" when the SQL files were not shipped.
    return Response.json(
      {
        ok: pending.length === 0 && files.platform.length > 0,
        pods: pods.length,
        pendingPlatformMigrations: pending,
        platformMigrations: files.platform.length,
      },
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
