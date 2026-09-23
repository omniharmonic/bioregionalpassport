'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Ceremony, Outbox, PodClient, openWallet, type PodRow, type Wallet } from '@passport/pod-client';

export interface WalletState {
  /** Null until IndexedDB has been opened in the browser. */
  wallet: Wallet | null;
  ready: boolean;
  exists: boolean;
  pods: PodRow[];
  /** The pod the wallet is showing (`?pod=` or the last used one). */
  slug: string | undefined;
  pod: PodRow | undefined;
  /** Bumps whenever wallet data changes, so views re-read. */
  version: number;
  pendingOutbox: number;
  reload(): Promise<void>;
  selectPod(slug: string): void;
  /** A client for a pod, signed with this wallet's persona there. */
  clientFor(slug?: string): Promise<PodClient>;
  ceremonyFor(slug?: string): Promise<Ceremony>;
  flushOutbox(): Promise<void>;
  /** `href` with the current pod attached, for links inside the wallet. */
  href(path: string): string;
}

const Ctx = createContext<WalletState | null>(null);

export function useWalletState(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWalletState must be used inside <WalletProvider>.');
  return v;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? '/wallet';
  const podParam = params?.get('pod') ?? undefined;

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [exists, setExists] = useState(false);
  const [pods, setPods] = useState<PodRow[]>([]);
  const [lastPod, setLastPodState] = useState<string | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState(0);
  const [pendingOutbox, setPending] = useState(0);

  // IndexedDB only exists in the browser: open the wallet after mount.
  useEffect(() => {
    setWallet(openWallet());
  }, []);

  const reload = useCallback(async () => {
    if (!wallet) return;
    const [e, p, l, n] = await Promise.all([wallet.exists(), wallet.pods(), wallet.lastPod(), wallet.db.outbox.count()]);
    setExists(e);
    setPods(p);
    setLastPodState(l);
    setPending(n);
    setReady(true);
    setVersion((v) => v + 1);
  }, [wallet]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const outbox = useMemo(() => (wallet ? new Outbox(wallet.db, (u, i) => fetch(u, i)) : null), [wallet]);

  const flushOutbox = useCallback(async () => {
    if (!outbox || !wallet) return;
    await outbox.flush();
    setPending(await wallet.db.outbox.count());
  }, [outbox, wallet]);

  // Offline ceremony: queued relay messages go out when the device reconnects.
  useEffect(() => {
    if (!outbox) return;
    void flushOutbox();
    const onOnline = () => void flushOutbox();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [outbox, flushOutbox]);

  const slug = useMemo(() => {
    if (podParam && pods.some((p) => p.slug === podParam)) return podParam;
    if (lastPod && pods.some((p) => p.slug === lastPod)) return lastPod;
    return pods[0]?.slug;
  }, [podParam, lastPod, pods]);
  const pod = pods.find((p) => p.slug === slug);

  // Remember the pod the person is looking at.
  useEffect(() => {
    if (wallet && slug && slug !== lastPod) void wallet.setLastPod(slug).then(() => setLastPodState(slug));
  }, [wallet, slug, lastPod]);

  const selectPod = useCallback(
    (next: string) => {
      const q = new URLSearchParams(params?.toString() ?? '');
      q.set('pod', next);
      router.replace(`${pathname}?${q.toString()}`);
      if (wallet) void wallet.setLastPod(next).then(() => setLastPodState(next));
    },
    [params, pathname, router, wallet],
  );

  const clientFor = useCallback(
    async (s?: string) => {
      if (!wallet) throw new Error('Your passport is still opening.');
      const target = s ?? slug;
      if (!target) throw new Error('Choose a pod first.');
      const row = await wallet.pod(target);
      if (!row) throw new Error('This passport has not joined that pod yet.');
      const persona = await wallet.personaFor(target);
      return new PodClient({ slug: target, manifest: row.manifest, db: wallet.db, ...(persona ? { persona } : {}) });
    },
    [wallet, slug],
  );

  const ceremonyFor = useCallback(
    async (s?: string) => {
      const client = await clientFor(s);
      return new Ceremony({ wallet: wallet!, relay: client.relay(), pod: client.slug });
    },
    [clientFor, wallet],
  );

  const href = useCallback((path: string) => (slug ? `${path}${path.includes('?') ? '&' : '?'}pod=${encodeURIComponent(slug)}` : path), [slug]);

  const value: WalletState = {
    wallet,
    ready,
    exists,
    pods,
    slug,
    pod,
    version,
    pendingOutbox,
    reload,
    selectPod,
    clientFor,
    ceremonyFor,
    flushOutbox,
    href,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
