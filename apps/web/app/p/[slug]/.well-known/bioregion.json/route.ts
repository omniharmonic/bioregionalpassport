import { findPod } from '@/lib/pod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The pod's signed manifest. Reached as `https://<slug>.<domain>/.well-known/bioregion.json`
 * through the proxy rewrite, or directly at `/p/<slug>/.well-known/bioregion.json`.
 */
export async function GET(_req: Request, ctx: RouteContext<'/p/[slug]/.well-known/bioregion.json'>) {
  const { slug } = await ctx.params;
  try {
    const pod = await findPod(slug);
    if (!pod || pod.status !== 'active') {
      return Response.json({ code: 'POD_NOT_FOUND', message: `No active pod is registered as ${slug}.` }, { status: 404 });
    }
    return new Response(JSON.stringify(pod.manifest, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=60, s-maxage=60',
        'access-control-allow-origin': '*',
      },
    });
  } catch (err) {
    console.error('[pod manifest]', err);
    return Response.json({ code: 'INTERNAL', message: 'Something went wrong on our side; please try again.' }, { status: 500 });
  }
}
