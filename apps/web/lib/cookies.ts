/** Session cookie constants and (de)serialisation — pure, shared by the mount layer and `lib/session.ts`. */

export const SESSION_COOKIE = 'passport_session';
/** One hour. */
export const SESSION_MAX_AGE_SEC = 60 * 60;

/** Reads one cookie from a `Cookie` header. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

/**
 * The `Domain` for the session cookie on a request to `host`: the platform domain when the host is the
 * platform domain or one of its sub-domains (so a session the wallet opens on `<platform>/wallet` reaches
 * `<slug>.<platform>` pod pages), otherwise `undefined` (host-only: localhost, custom domains, previews).
 */
export function sessionCookieDomain(host: string | null | undefined, platformDomain: string): string | undefined {
  const h = (host ?? '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const pd = platformDomain.trim().toLowerCase().replace(/^\./, '');
  if (!h || !pd || pd === 'localhost' || !pd.includes('.')) return undefined;
  return h === pd || h.endsWith(`.${pd}`) ? pd : undefined;
}

export function sessionCookieHeader(token: string, secure: boolean, domain?: string): string {
  const attrs = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', `Max-Age=${SESSION_MAX_AGE_SEC}`, 'HttpOnly', 'SameSite=Lax'];
  if (domain) attrs.push(`Domain=${domain}`);
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearSessionCookieHeader(secure: boolean, domain?: string): string {
  const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (domain) attrs.push(`Domain=${domain}`);
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * `Set-Cookie` values that sign out: the platform-wide cookie and, for sessions opened before the cookie
 * carried a `Domain`, the host-only one.
 */
export function clearSessionCookieHeaders(secure: boolean, domain?: string): string[] {
  return domain ? [clearSessionCookieHeader(secure, domain), clearSessionCookieHeader(secure)] : [clearSessionCookieHeader(secure)];
}
