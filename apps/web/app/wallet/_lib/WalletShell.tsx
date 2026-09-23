'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@passport/ui-kit';
import { themeSource } from '@/lib/theme';
import { useWalletState } from './WalletContext';

const PLATFORM_THEME = {
  theme: {
    tokens: { primary: 'var(--bp-primary)', accent: 'var(--bp-accent)', bg: 'var(--bp-bg)', fg: 'var(--bp-fg)' },
    font: { display: 'var(--bp-font-display)', body: 'var(--bp-font-body)' },
    tone: 'plain',
  },
};

/** Wallet chrome: the selected pod's theme (ThemeProvider), pod switcher and wallet navigation. */
export function WalletShell({ children }: { children: ReactNode }) {
  const w = useWalletState();
  const pathname = usePathname() ?? '/wallet';
  const manifest = w.pod?.manifest;
  const links = [
    { href: '/wallet', label: 'Passport', exact: true },
    { href: '/wallet/meet', label: 'Meet' },
    { href: '/wallet/events', label: 'Events' },
    { href: '/wallet/vouch', label: 'Vouch' },
    ...(manifest?.modules.circulation
      ? [
          { href: '/wallet/pay', label: 'Pay' },
          { href: '/wallet/earn', label: 'Earn' },
        ]
      : []),
    { href: '/wallet/settings', label: 'Settings' },
  ];
  const showNav = w.ready && w.exists && w.pods.length > 0;

  return (
    <ThemeProvider manifest={manifest ? themeSource(manifest) : PLATFORM_THEME}>
      <div className="flex min-h-screen flex-col">
        <header className="border-b rule">
          <div className="mx-auto flex max-w-3xl flex-col gap-3 px-5 py-4 sm:px-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Link href={w.href('/wallet')} className="flex items-center gap-3 no-underline" style={{ color: 'var(--bp-fg)' }}>
                <span
                  aria-hidden="true"
                  className="grid h-9 w-9 place-items-center rounded-full font-display text-lg"
                  style={{ background: 'var(--bp-primary)', color: 'var(--bp-bg)' }}
                >
                  {manifest ? manifest.identity.name.slice(0, 1) : 'P'}
                </span>
                <span className="grid leading-tight">
                  <span className="font-display text-lg font-semibold">Passport</span>
                  {manifest ? <span className="text-xs muted">{manifest.identity.name}</span> : null}
                </span>
              </Link>
              {w.pods.length > 1 ? (
                <label className="flex items-center gap-2 text-sm">
                  <span className="muted">Pod</span>
                  <select
                    className="rounded-2xl px-3 py-1.5 text-sm"
                    style={{ background: 'var(--bp-bg)', color: 'var(--bp-fg)', border: '1px solid var(--bp-rule)' }}
                    value={w.slug ?? ''}
                    onChange={(e) => w.selectPod(e.target.value)}
                  >
                    {w.pods.map((p) => (
                      <option key={p.slug} value={p.slug}>
                        {p.manifest.identity.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : manifest ? (
                <a href={`/p/${manifest.identity.slug}`} className="text-sm">
                  Visit {manifest.identity.name}
                </a>
              ) : null}
            </div>
            {showNav ? (
              <nav aria-label="Passport" className="flex flex-wrap gap-1">
                {links.map((l) => {
                  const active = l.exact ? pathname === l.href : pathname === l.href || pathname.startsWith(`${l.href}/`);
                  return (
                    <Link
                      key={l.href}
                      href={w.href(l.href)}
                      aria-current={active ? 'page' : undefined}
                      className="rounded-2xl px-3 py-1.5 text-sm font-medium no-underline"
                      style={{ background: active ? 'color-mix(in srgb, var(--bp-primary) 15%, transparent)' : 'transparent', color: 'var(--bp-fg)' }}
                    >
                      {l.label}
                    </Link>
                  );
                })}
              </nav>
            ) : null}
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-5 py-8 sm:px-8">
          {w.ready ? children : <p role="status" className="muted">Opening your passport…</p>}
        </main>
        <footer className="border-t rule">
          <p className="mx-auto max-w-3xl px-5 py-6 text-xs muted sm:px-8">
            Your keys and credentials live on this device. Nothing leaves it unless you present it or download your own backup.
          </p>
        </footer>
      </div>
    </ThemeProvider>
  );
}
