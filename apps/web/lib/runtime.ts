import 'server-only';
import { withPod } from '@passport/db';
import { readSession } from '@passport/verifier-sdk';
import type { SessionClaims } from '@passport/service-kit';
import { db } from './db';
import { env } from './env';
import type { MountDeps } from './mount';
import { findPod } from './pod';

/** Converts verifier-sdk session claims to the service-kit shape handlers receive. */
export function toSessionClaims(raw: Awaited<ReturnType<typeof readSession>>): SessionClaims | null {
  if (!raw) return null;
  const claims: SessionClaims = { subject: raw.subject, pod: raw.pod ?? '', authorities: raw.authorities ?? [] };
  if (raw.tier) claims.tier = raw.tier;
  if (raw.delegatedFor) claims.delegatedFor = raw.delegatedFor;
  return claims;
}

/** Real database/session wiring for `mountService`. */
export function runtimeDeps(): MountDeps {
  const e = env();
  return {
    platformDomain: e.PLATFORM_DOMAIN,
    customDomains: e.POD_CUSTOM_DOMAINS,
    operatorToken: e.OPERATOR_TOKEN,
    secureCookies: e.isProduction,
    masterKey: e.POD_KEY_ENCRYPTION_KEY,
    findPod,
    withPod: (slug, fn) => withPod(db(), slug, fn),
    platformDb: () => db(),
    readSession: async (token) => toSessionClaims(await readSession(token, e.SESSION_SECRET)),
  };
}
