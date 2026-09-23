import { copy, type BioregionManifest } from '@passport/tenant-config';

export interface PodLink {
  key: string;
  label: string;
  href: string;
  /** Short description for launcher tiles. */
  blurb: string;
  /** Exact-match only (Home). */
  exact?: boolean;
}

/** Whether a session may see the Steward link for the pod `podDid`: same pod and `pep:review`. */
export function isStewardSession(session: { pod?: string; authorities?: readonly string[] } | null | undefined, podDid: string): boolean {
  return Boolean(session && session.pod === podDid && session.authorities?.includes('pep:review'));
}

/** Link base for a pod: '' on its own host (`boulder.<domain>`), `/p/<slug>` on the platform host. */
export function podBase(slug: string, onPodHost: boolean): string {
  return onPodHost ? '' : `/p/${slug}`;
}

export interface PodLinkOptions {
  /** The viewer's session for this pod carries `pep:review`: add the Steward console link. */
  steward?: boolean;
}

/**
 * Pod navigation from `manifest.modules`, in the plan's order. The Passport link is always
 * `/wallet?pod=<slug>`: `/wallet` is served on both the platform host and the pod's own host.
 */
export function podLinks(manifest: BioregionManifest, base: string, opts: PodLinkOptions = {}): PodLink[] {
  const slug = manifest.identity.slug;
  const m = manifest.modules;
  const links: (PodLink | false)[] = [
    { key: 'home', label: 'Home', href: base || '/', blurb: '', exact: true },
    m.map && { key: 'map', label: copy(manifest, 'module.map'), href: `${base}/map`, blurb: 'Places, projects and neighbors on the land.' },
    { key: 'directory', label: 'Directory', href: `${base}/directory`, blurb: 'Local enterprises, groups and what they offer.' },
    { key: 'events', label: 'Events', href: `${base}/events`, blurb: 'Gatherings where neighbors meet and vouch.' },
    m.grants && { key: 'grants', label: copy(manifest, 'module.grants'), href: `${base}/grants`, blurb: 'Propose projects and vote on shared funds.' },
    m.circulation && { key: 'credits', label: copy(manifest, 'module.circulation'), href: `${base}/circulation`, blurb: 'Pay and earn in local credit.' },
    m.circulation &&
      m.merchant && { key: 'merchant', label: 'Merchant Mode', href: `${base}/merchant`, blurb: 'Accept credits at your enterprise.' },
    { key: 'passport', label: 'Passport', href: `/wallet?pod=${encodeURIComponent(slug)}`, blurb: 'Your credentials, held on your own device.' },
    { key: 'governance', label: 'Governance', href: `${base}/governance`, blurb: 'Who stewards this pod, and by what rules.' },
    opts.steward === true && { key: 'steward', label: 'Steward', href: `${base}/steward`, blurb: 'Review members, tiers and disputes.' },
  ];
  return links.filter((l): l is PodLink => Boolean(l));
}
