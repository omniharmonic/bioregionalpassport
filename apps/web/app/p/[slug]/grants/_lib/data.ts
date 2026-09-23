/**
 * Server-side access to the grants round service for pod pages: the same service functions the
 * `/api/round` mount calls, run inside the pod transaction (`withPod`), like the events page does.
 */
import 'server-only';
import { notFound } from 'next/navigation';
import { withPod } from '@passport/db';
import type { RoundContext } from '@passport/round';
import type { SessionClaims } from '@passport/service-kit';
import { db } from '@/lib/db';
import { platformDomain } from '@/lib/env';
import type { LoadedPod } from '@/lib/pod';
import { tierName } from '@/lib/podCopy';
import { getSession } from '@/lib/session';
import type { BioregionManifest } from '@passport/tenant-config';

export const STEWARD_SCOPE = 'pep:review';

/** Runs `fn` with a `RoundContext` for this pod. */
export function withRound<T>(pod: LoadedPod, fn: (ctx: RoundContext) => Promise<T>): Promise<T> {
  return withPod(db(), pod.slug, (tx) =>
    fn({ slug: pod.slug, podDid: pod.did, db: tx, manifest: pod.manifest, policy: pod.policy, now: () => new Date(), platformDomain: platformDomain() }),
  );
}

/** The session when it was issued by this pod, else null. */
export async function podSession(pod: LoadedPod): Promise<SessionClaims | null> {
  const s = await getSession();
  return s && s.pod === pod.did ? s : null;
}

export const can = (s: SessionClaims | null, scope: string): boolean => !!s && s.authorities.includes(scope);

/** Maps a service 404 (unknown round) to the not-found page; rethrows everything else. */
export function notFoundOn404(err: unknown): never {
  if (err && typeof err === 'object' && (err as { status?: number }).status === 404) notFound();
  throw err;
}

/** The pod's host, used as the presentation domain for group votes. */
export const podDomain = (slug: string): string => `${slug}.${platformDomain()}`;

/** The pod's own name for the T2 standing (defaults to "Trusted"). */
export function trustedName(manifest: BioregionManifest): string {
  const name = tierName(manifest, 'T2');
  return name === 'T2' ? 'Trusted' : name;
}
