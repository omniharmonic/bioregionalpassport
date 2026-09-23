import { didDocumentFor } from '@passport/control-plane';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { isSlug } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const notFound = (slug: string) =>
  Response.json({ code: 'DID_NOT_FOUND', message: `No pod DID is hosted for ${slug}.` }, { status: 404 });

/** did:web document for `did:web:<PLATFORM_DOMAIN>:dids:<slug>` (ADR-21). */
export async function GET(_req: Request, ctx: RouteContext<'/dids/[slug]/did.json'>) {
  const { slug } = await ctx.params;
  if (!isSlug(slug)) return notFound(slug);
  try {
    const doc = await didDocumentFor(db(), slug, env().PLATFORM_DOMAIN);
    if (!doc) return notFound(slug);
    return new Response(JSON.stringify(doc, null, 2), {
      headers: {
        'content-type': 'application/did+json',
        'cache-control': 'public, max-age=300, s-maxage=300',
        'access-control-allow-origin': '*',
      },
    });
  } catch (err) {
    console.error('[did.json]', err);
    return Response.json({ code: 'INTERNAL', message: 'Something went wrong on our side; please try again.' }, { status: 500 });
  }
}
