import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@passport/ui-kit';
import { PodNav } from '@/components/PodNav';
import { platformDomain } from '@/lib/env';
import { loadPod } from '@/lib/pod';
import { isStewardSession, podLinks } from '@/lib/podNav';
import { currentPodBase } from '@/lib/podRequest';
import { getSession } from '@/lib/session';
import { themeSource } from '@/lib/theme';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: LayoutProps<'/p/[slug]'>): Promise<Metadata> {
  const { slug } = await params;
  const pod = await loadPod(slug);
  return {
    title: { default: pod.manifest.identity.name, template: `%s · ${pod.manifest.identity.name}` },
    description: `${pod.manifest.identity.name} on Bioregional Passport.`,
  };
}

export default async function PodLayout({ children, params }: LayoutProps<'/p/[slug]'>) {
  const { slug } = await params;
  const pod = await loadPod(slug);
  const { manifest } = pod;
  const [base, session] = await Promise.all([currentPodBase(slug), getSession().catch(() => null)]);
  const links = podLinks(manifest, base, { steward: isStewardSession(session, pod.did) });
  const manifestHref = `${base}/.well-known/bioregion.json`;
  const domain = platformDomain();

  return (
    <ThemeProvider manifest={themeSource(manifest)}>
      <div className="flex min-h-screen flex-col">
        <header className="border-b rule">
          <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-10">
            <a href={base || '/'} className="flex items-center gap-3 no-underline" style={{ color: 'var(--bp-fg)' }}>
              {manifest.theme.logo ? (
                // Logos are arbitrary pod-hosted URLs from the manifest; next/image would need each host allow-listed.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={manifest.theme.logo} alt="" width={36} height={36} className="h-9 w-9 rounded-full" />
              ) : (
                <span
                  aria-hidden="true"
                  className="grid h-9 w-9 place-items-center rounded-full font-display text-lg"
                  style={{ background: 'var(--bp-primary)', color: 'var(--bp-bg)' }}
                >
                  {manifest.identity.name.slice(0, 1)}
                </span>
              )}
              <span className="font-display text-xl font-semibold">{manifest.identity.name}</span>
            </a>
            <PodNav links={links} />
          </div>
        </header>

        <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-6 py-12 sm:px-10">
          {children}
        </main>

        <footer className="border-t rule">
          <div className="mx-auto grid max-w-5xl gap-2 px-6 py-8 text-sm muted sm:px-10">
            <p>
              Pod identifier: <code className="break-all">{pod.did}</code>
            </p>
            <p className="flex flex-wrap gap-x-5 gap-y-1">
              <a href={manifestHref}>Signed manifest</a>
              <a href={`${base}/governance`}>Governance</a>
              <a href={`https://${domain}`}>Bioregional Passport</a>
            </p>
          </div>
        </footer>
      </div>
    </ThemeProvider>
  );
}
