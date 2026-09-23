import 'server-only';
import { cookies, headers } from 'next/headers';
import { readSession } from '@passport/verifier-sdk';
import type { SessionClaims } from '@passport/service-kit';
import { SESSION_COOKIE, SESSION_MAX_AGE_SEC, sessionCookieDomain } from './cookies';
import { env } from './env';
import { toSessionClaims } from './runtime';

export { SESSION_COOKIE };

/** The verified `passport_session` for the current request (server components, route handlers), or null. */
export async function getSession(): Promise<SessionClaims | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    return toSessionClaims(await readSession(token, env().SESSION_SECRET));
  } catch {
    return null;
  }
}

/** Platform-wide cookie domain for this request (see `sessionCookieDomain`), or undefined for host-only. */
async function cookieDomain(): Promise<string | undefined> {
  const h = await headers();
  return sessionCookieDomain(h.get('x-forwarded-host') ?? h.get('host'), env().PLATFORM_DOMAIN);
}

/** Sets the session cookie (route handlers and server actions only). */
export async function setSessionCookie(token: string): Promise<void> {
  const domain = await cookieDomain();
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env().isProduction,
    path: '/',
    maxAge: SESSION_MAX_AGE_SEC,
    ...(domain ? { domain } : {}),
  });
}

/** Clears the session cookie (route handlers and server actions only). */
export async function clearSessionCookie(): Promise<void> {
  const domain = await cookieDomain();
  const jar = await cookies();
  if (domain) jar.set(SESSION_COOKIE, '', { path: '/', maxAge: 0, domain });
  else jar.delete(SESSION_COOKIE);
}
