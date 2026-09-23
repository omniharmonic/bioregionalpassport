import type { Metadata } from 'next';
import { listPodCards, type PodCard } from '@passport/control-plane';
import { db } from '@/lib/db';
import { platformDomain } from '@/lib/env';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { absolute: 'Bioregional Passport' },
};

const DOCS_URL = 'https://github.com/omniharmonic/bioregionalpassport';

async function loadPods(): Promise<{ pods: PodCard[]; error: boolean }> {
  try {
    return { pods: await listPodCards(db(), platformDomain()), error: false };
  } catch (err) {
    console.error('[landing] could not list pods', err);
    return { pods: [], error: true };
  }
}

const PRINCIPLES = [
  {
    title: 'Vouched for by neighbors',
    body: 'Your standing comes from people who have met you in person, not from a state office or a company. Membership starts at a gathering, where a neighbor vouches for you and a convener witnesses it.',
  },
  {
    title: 'Held by you',
    body: 'Your credentials live on your own device. You decide what to show, to whom, and for how long; the pod keeps only what it needs to recognise you.',
  },
  {
    title: 'Credit is never sold',
    body: 'Local credits are issued by members to one another against real goods and services. There is nothing to buy in, nothing to speculate on, and no one to cash out to.',
  },
  {
    title: 'Every bioregion governs itself',
    body: 'Each pod sets its own trust rules, stewards and look, and can pack up and leave with all of its records. This platform hosts; it does not rule.',
  },
];

export default async function LandingPage() {
  const domain = platformDomain();
  const { pods, error } = await loadPods();

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 pt-8 sm:px-10">
        <a href="/" className="font-display text-lg font-semibold no-underline" style={{ color: 'var(--bp-fg)' }}>
          Bioregional Passport
        </a>
        <nav aria-label="Platform">
          <ul className="flex gap-6 text-sm">
            <li>
              <a href="#pods">Pods</a>
            </li>
            <li>
              <a href="#operators">For operators</a>
            </li>
          </ul>
        </nav>
      </header>

      <main id="main">
        <section className="mx-auto max-w-5xl px-6 pb-20 pt-20 sm:px-10 sm:pt-28" aria-labelledby="intro-title">
          <p className="eyebrow">A civic commons for the place you live</p>
          <h1 id="intro-title" className="mt-4 max-w-3xl text-4xl font-medium sm:text-6xl">
            A passport your neighbors vouch for.
          </h1>
          <div className="mt-10 grid max-w-3xl gap-6 text-lg">
            <p>
              Bioregional Passport lets the people of a watershed recognise one another. You earn membership by meeting
              neighbors in person at a gathering; they vouch for you, a convener witnesses it, and your pod issues a
              credential that says you belong here. No government ID, no company account.
            </p>
            <p>
              That credential is yours. It lives in a passport on your own phone, and you choose when to show it: to vote
              on a local grant, to open a credit account with nearby businesses, or to prove you are a neighbor without
              saying who you are.
            </p>
            <p>
              Each bioregion runs its own pod, with its own rules for trust, its own stewards and its own look. Local
              credits are issued between members and are never sold. Pods can leave this platform at any time and take
              everything with them.
            </p>
          </div>
        </section>

        <section className="border-y rule" aria-labelledby="principles-title" style={{ background: 'color-mix(in srgb, var(--bp-primary) 4%, var(--bp-bg))' }}>
          <div className="mx-auto max-w-5xl px-6 py-16 sm:px-10">
            <h2 id="principles-title" className="text-2xl font-medium sm:text-3xl">
              Four commitments
            </h2>
            <ol className="mt-10 grid gap-x-12 gap-y-10 sm:grid-cols-2">
              {PRINCIPLES.map((p, i) => (
                <li key={p.title} className="flex gap-5">
                  <span aria-hidden="true" className="font-display text-3xl leading-none" style={{ color: 'var(--bp-primary)' }}>
                    {i + 1}
                  </span>
                  <div>
                    <h3 className="text-xl font-medium">{p.title}</h3>
                    <p className="mt-2 muted">{p.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="pods" className="mx-auto max-w-5xl px-6 py-20 sm:px-10" aria-labelledby="pods-title">
          <h2 id="pods-title" className="text-2xl font-medium sm:text-3xl">
            Pods on this platform
          </h2>
          <p className="mt-3 max-w-2xl muted">
            A pod is one bioregion&rsquo;s commons: its members, its gatherings, its map and its credits.
          </p>
          {error ? (
            <p role="status" className="mt-8 rounded-2xl border rule p-6">
              The list of pods is not available right now. Please try again in a moment.
            </p>
          ) : pods.length === 0 ? (
            <p className="mt-8 rounded-2xl border rule p-6">No pods have opened yet.</p>
          ) : (
            <ul className="mt-10 grid gap-6 sm:grid-cols-2">
              {pods.map((pod) => (
                <li key={pod.slug} className="flex flex-col rounded-2xl border rule p-7" style={{ background: '#fffdf8' }}>
                  <h3 className="text-2xl font-medium">
                    <a href={`https://${pod.slug}.${domain}`} className="no-underline hover:underline" style={{ color: 'var(--bp-fg)' }}>
                      {pod.name}
                    </a>
                  </h3>
                  <p className="mt-1 text-sm muted">
                    {pod.slug}.{domain}
                  </p>
                  <p className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                    <a href={`https://${pod.slug}.${domain}`}>
                      Visit <span className="sr-only">{pod.name}</span>
                    </a>
                    <a href={`/p/${pod.slug}`}>
                      Open here <span className="sr-only">({pod.name} on this site)</span>
                    </a>
                    <a href={pod.manifestUrl}>
                      Manifest <span className="sr-only">for {pod.name}</span>
                    </a>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section id="operators" className="border-t rule" aria-labelledby="operators-title">
          <div className="mx-auto grid max-w-5xl gap-8 px-6 py-20 sm:grid-cols-[1fr_1.4fr] sm:px-10">
            <h2 id="operators-title" className="text-2xl font-medium sm:text-3xl">
              For pod operators
            </h2>
            <div className="grid gap-4 text-lg">
              <p>
                Opening a pod for your bioregion takes a manifest: a short file naming your commons, its colours and
                words, its boundaries, and the rules by which neighbors come to trust one another. The platform turns it
                into a running pod with its own address and signing key.
              </p>
              <p className="flex flex-wrap gap-x-6 gap-y-2 text-base">
                <a href="/operator">Operator console</a>
                <a href={DOCS_URL}>Documentation and source on GitHub</a>
                <a href="/.well-known/bioregion.json">Platform card (JSON)</a>
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t rule">
        <div className="mx-auto flex max-w-5xl flex-wrap justify-between gap-4 px-6 py-8 text-sm muted sm:px-10">
          <p>Bioregional Passport · open source under Apache-2.0</p>
          <p>{domain}</p>
        </div>
      </footer>
    </div>
  );
}
