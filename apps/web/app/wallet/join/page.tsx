'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Notice } from '@passport/ui-kit';

const SLUG_RE = /^[a-z0-9-]{2,40}$/;

/**
 * URL-scheme mapping for deep links. `passport://join/<slug>` (native app scheme, `manifest.build.scheme`) and
 * `web+passport://join/<slug>` (the PWA's `protocol_handlers` entry, which arrives here as `?to=<url>`) both
 * resolve to `/wallet/join/<slug>`; `?pod=<slug>` works too.
 */
function slugFromDeepLink(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^(?:web\+)?passport:\/\/join\/([^/?#]+)/i.exec(raw.trim()) ?? /^\/?wallet\/join\/([^/?#]+)/.exec(raw.trim());
  const slug = (m?.[1] ?? raw).trim().toLowerCase();
  return SLUG_RE.test(slug) ? slug : null;
}

export default function JoinRedirect() {
  const params = useSearchParams();
  const router = useRouter();
  const [bad, setBad] = useState(false);
  useEffect(() => {
    const slug = slugFromDeepLink(params?.get('to')) ?? slugFromDeepLink(params?.get('pod'));
    if (slug) router.replace(`/wallet/join/${slug}`);
    else setBad(true);
  }, [params, router]);
  return bad ? <Notice kind="error">This link does not name a pod to join.</Notice> : <p className="muted">Opening the invitation…</p>;
}
