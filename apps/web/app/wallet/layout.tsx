import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';
import { WalletProvider } from './_lib/WalletContext';
import { WalletShell } from './_lib/WalletShell';

export const metadata: Metadata = {
  title: { default: 'Passport', template: '%s · Passport' },
  description: 'Your bioregional passport: credentials your neighbors vouch for, held on your own device.',
  appleWebApp: { capable: true, title: 'Passport', statusBarStyle: 'default' },
};

/** The wallet PWA (ADR-25): everything below runs in the browser against IndexedDB. */
export default function WalletLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<p className="p-8 muted">Opening your passport…</p>}>
      <WalletProvider>
        <WalletShell>{children}</WalletShell>
      </WalletProvider>
    </Suspense>
  );
}
