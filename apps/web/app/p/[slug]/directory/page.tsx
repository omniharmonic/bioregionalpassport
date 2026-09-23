import type { Metadata } from 'next';
import { listDirectory, listRecords } from '@passport/appview';
import { Button, Card, EmptyState, Explain, Field, Input, PageHeader, Pill, Select } from '@passport/ui-kit';
import { loadPod } from '@/lib/pod';
import { currentPodBase } from '@/lib/podRequest';
import { getSession } from '@/lib/session';
import { withAppview } from './_lib/appview';
import { categoriesOf, parseDirectoryQuery, plural, toCard, type DirectoryCard } from './_lib/entries';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Directory' };

/**
 * Directory of local enterprises. Reads the same AppView function as `GET /api/appview/directory` (with its
 * `q`, `category` and `acceptsLocalCredit` filters) directly inside the pod transaction, as the other pod pages do.
 */
export default async function DirectoryPage({ params, searchParams }: PageProps<'/p/[slug]/directory'>) {
  const { slug } = await params;
  const query = parseDirectoryQuery(await searchParams);
  const pod = await loadPod(slug);
  const [base, session] = await Promise.all([currentPodBase(slug), getSession().catch(() => null)]);
  const canPay = Boolean(session && session.pod === pod.did && session.authorities.includes('credit:account'));
  const showMap = pod.manifest.modules.map;

  let cards: DirectoryCard[] | null = null;
  let categories: string[] = [];
  try {
    const out = await withAppview(pod, async (ctx) => {
      const entries = await listDirectory(ctx, {
        ...(query.q ? { q: query.q } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.credits ? { acceptsLocalCredit: true } : {}),
      });
      const all = await listRecords(ctx, 'enterprise', { limit: 200 });
      return { entries, all: all.rows };
    });
    cards = out.entries.map(toCard);
    categories = categoriesOf(out.all);
  } catch (err) {
    console.error('[directory] could not list enterprises', err);
  }
  if (query.category && !categories.includes(query.category)) categories = [...categories, query.category];
  const filtered = Boolean(query.q || query.category || query.credits);
  const payHref = `/wallet/pay?pod=${encodeURIComponent(slug)}`;

  return (
    <div className="grid gap-8">
      <PageHeader title="Directory" subtitle={`Local enterprises in ${pod.manifest.identity.name}.`} />
      <Explain>Enterprises, what they offer and what they need, published as open records anyone can read.</Explain>

      <form method="get" action={`${base}/directory`} role="search" className="grid gap-4 sm:grid-cols-[1fr_14rem] sm:items-end">
        <Field label="Search" htmlFor="dir-q">
          <Input id="dir-q" name="q" type="search" defaultValue={query.q} placeholder="Bread, bike repair, childcare…" maxLength={200} />
        </Field>
        <Field label="Category" htmlFor="dir-category">
          <Select id="dir-category" name="category" defaultValue={query.category}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="credits" value="1" defaultChecked={query.credits} />
          Only places that accept credits
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit">Search</Button>
          {filtered ? <a href={`${base}/directory`}>Clear</a> : null}
        </div>
      </form>

      {cards === null ? (
        <p role="status">The directory is not available right now. Please try again in a moment.</p>
      ) : cards.length === 0 ? (
        <EmptyState
          title={filtered ? 'No enterprises match' : 'No enterprises listed yet'}
          body={filtered ? 'Try a different word or category, or clear the filters.' : 'Enterprises appear here once they publish a listing.'}
        />
      ) : (
        <>
          <p role="status" className="text-sm muted">
            {plural(cards.length, 'enterprise', 'enterprises')}
            {filtered ? ' match' : ''}.
          </p>
          <ul className="grid gap-5 sm:grid-cols-2">
            {cards.map((c) => (
              <li key={c.uri} id={c.anchor} className="scroll-mt-24">
                <Card className="grid h-full gap-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h2 className="text-xl font-medium">{c.name}</h2>
                    {c.acceptsCredits ? (
                      <Pill tone="accent">
                        Accepts credits{c.acceptanceShare !== null ? ` (up to ${Math.round(c.acceptanceShare * 100)}%)` : ''}
                      </Pill>
                    ) : null}
                  </div>
                  {c.categories.length ? (
                    <ul className="flex flex-wrap gap-2" aria-label="Categories">
                      {c.categories.map((cat) => (
                        <li key={cat}>
                          <Pill>{cat}</Pill>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {c.description ? <p>{c.description}</p> : null}
                  {c.address ? <p className="text-sm muted">{c.address}</p> : null}
                  <p className="text-sm muted">
                    {plural(c.offerCount, 'offer', 'offers')} · {plural(c.needCount, 'need', 'needs')}
                  </p>
                  <p className="mt-auto flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    {showMap && c.mappable ? <a href={`${base}/map?focus=${encodeURIComponent(c.uri)}`}>Show on the map</a> : null}
                    {canPay && c.acceptsCredits ? <a href={payHref}>Pay with credits</a> : null}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
