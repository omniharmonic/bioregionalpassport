import { Button, Card, Explain, TierBadge, type Tier } from '@passport/ui-kit';
import { copy } from '@passport/tenant-config';
import { loadPod } from '@/lib/pod';
import { describeRequirement, greeting, tierName } from '@/lib/podCopy';
import { isStewardSession, podLinks } from '@/lib/podNav';
import { currentPlatformOrigin, currentPodBase } from '@/lib/podRequest';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

const TIERS = new Set(['T0', 'T1', 'T2', 'T3', 'T4']);

export default async function PodHome({ params }: PageProps<'/p/[slug]'>) {
  const { slug } = await params;
  const [pod, base, session, platformOrigin] = await Promise.all([
    loadPod(slug),
    currentPodBase(slug),
    getSession().catch(() => null),
    currentPlatformOrigin(),
  ]);
  const { manifest } = pod;
  const { title, lede } = greeting(manifest);
  const tiles = podLinks(manifest, base, { steward: isStewardSession(session, pod.did), platformOrigin }).filter((l) => l.key !== 'home');
  const mySession = session && session.pod === pod.did ? session : null;
  const tier = mySession?.tier && TIERS.has(mySession.tier) ? (mySession.tier as Tier) : null;

  return (
    <div className="grid gap-16">
      <section aria-labelledby="welcome" className="grid gap-6">
        <h1 id="welcome" className="max-w-3xl text-4xl font-medium sm:text-5xl">
          {title}
        </h1>
        <p className="max-w-2xl text-lg">{lede}</p>
        <div className="flex flex-wrap items-center gap-4">
          <Button href={`${base}/events`} size="lg">
            {copy(manifest, 'cta.findEvent')}
          </Button>
          {tier ? (
            <p className="flex items-center gap-3 text-sm">
              <span>Your standing here:</span>
              <TierBadge tier={tier} name={tierName(manifest, tier)} />
              <a href={`/wallet?pod=${encodeURIComponent(slug)}`}>Why this tier?</a>
            </p>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="modules" className="grid gap-6">
        <h2 id="modules" className="text-2xl font-medium">
          In {manifest.identity.name}
        </h2>
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {tiles.map((t) => (
            <li key={t.key}>
              <Card className="h-full">
                <h3 className="text-xl font-medium">
                  <a href={t.href}>{t.label}</a>
                </h3>
                <p className="mt-2 text-sm muted">{t.blurb}</p>
              </Card>
            </li>
          ))}
          {manifest.modules.thirdParty.map((app) => (
            <li key={app.id}>
              <Card className="h-full">
                <h3 className="text-xl font-medium">
                  <a href={app.deepLink}>{app.name}</a>
                </h3>
                <p className="mt-2 text-sm muted">A companion app that works with your passport.</p>
                {app.requires.length > 0 ? (
                  <Explain className="mt-4">
                    {`Needs ${app.requires.map((r) => describeRequirement(manifest, r)).join(' and ')}.`}
                  </Explain>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
