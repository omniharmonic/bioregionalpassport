import 'server-only';
import { cookies } from 'next/headers';
import { readSession } from '@passport/verifier-sdk';
import type { SessionClaims } from '@passport/service-kit';
import { SESSION_COOKIE, SESSION_MAX_AGE_SEC } from './cookies';
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

/** Sets the session cookie (route handlers and server actions only). */
export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env().isProduction,
    path: '/',
    maxAge: SESSION_MAX_AGE_SEC,
  });
}

/** Clears the session cookie (route handlers and server actions only). */
export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
