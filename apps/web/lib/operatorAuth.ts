/**
 * Bearer-token auth for the operator-only `/api/control/health` route (Task 15).
 *
 * The other control-plane routes are checked by `mountService`'s own `checkAuth`
 * (`./mount.ts`); this route is a plain Next.js route handler outside that mount
 * (services/control-plane is out of scope for Task 15), so it needs its own copy
 * of the same Bearer-only check that `checkAuth` applies to platform-scope
 * `operator` routes: a session never qualifies, only `OPERATOR_TOKEN`.
 *
 * Free of `server-only`/`./env` on purpose, so it stays a plain, unit-testable
 * module — the caller reads `OPERATOR_TOKEN` and passes it in.
 */

export class OperatorAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'OperatorAuthError';
  }
}

/** Constant-time string compare (always walks the longer of the two lengths). */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Extracts the token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(req: Request): string | null {
  const h = req.headers.get('authorization');
  const m = h ? /^Bearer\s+(.+)$/i.exec(h.trim()) : null;
  return m?.[1]?.trim() ?? null;
}

/**
 * Throws `OperatorAuthError` unless `req` carries the operator Bearer token.
 * `expected` is `OPERATOR_TOKEN`, read by the caller.
 */
export function requireOperator(req: Request, expected: string | undefined): void {
  const token = bearerToken(req);
  if (!token) {
    throw new OperatorAuthError(401, 'UNAUTHENTICATED', 'Send the operator key in an Authorization: Bearer header.');
  }
  if (!expected || !constantTimeEqual(token, expected)) {
    throw new OperatorAuthError(403, 'OPERATOR_ONLY', 'That operator key is not valid.');
  }
}
