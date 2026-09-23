/** Shared client-side fetch helper for the operator console's `/api/control/*` calls. */
export interface ApiError {
  code: string;
  message: string;
  hint?: string;
}

export function isApiError(v: unknown): v is ApiError {
  return typeof v === 'object' && v !== null && typeof (v as { message?: unknown }).message === 'string';
}

/** One-sentence message for a failure, whatever shape it came in. */
export function errorMessage(err: unknown): string {
  if (isApiError(err)) return err.hint ? `${err.message} ${err.hint}` : err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Please try again.';
}

/**
 * Fetches JSON from an operator-only route with the Bearer token attached. Throws an
 * `ApiError` (the server's `{code,message,hint?}`) on a non-2xx response.
 */
export async function operatorFetch<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...init, credentials: 'include', headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: ApiError = {
      code: typeof data.code === 'string' ? data.code : 'ERROR',
      message: typeof data.message === 'string' ? data.message : `The request failed (${res.status}).`,
      ...(typeof data.hint === 'string' ? { hint: data.hint } : {}),
    };
    throw err;
  }
  return data as T;
}
