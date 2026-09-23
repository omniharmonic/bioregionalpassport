import { listPodCards } from '@passport/control-plane';
import { db } from '@/lib/db';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Platform card: which pods this platform hosts. */
export async function GET() {
  try {
    const domain = env().PLATFORM_DOMAIN;
    const pods = await listPodCards(db(), domain);
    return Response.json(
      { platform: 'Bioregional Passport', domain, pods },
      { headers: { 'cache-control': 'public, max-age=60, s-maxage=60', 'access-control-allow-origin': '*' } },
    );
  } catch (err) {
    console.error('[platform card]', err);
    return Response.json({ code: 'INTERNAL', message: 'Something went wrong on our side; please try again.' }, { status: 500 });
  }
}
