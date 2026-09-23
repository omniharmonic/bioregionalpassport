/** Browser calls to the grants round service (`/api/round/…`), scoped to the pod with `X-Pod`. */

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; code: string; message: string };

export async function roundApi<T = unknown>(slug: string, path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { 'x-pod': slug, accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api/round${path}`, {
      method: init.method ?? 'GET',
      credentials: 'include',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    return { ok: false, status: 0, code: 'OFFLINE', message: 'We could not reach the pod. Check your connection and try again.' };
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.ok) return { ok: true, status: res.status, data: data as T };
  return {
    ok: false,
    status: res.status,
    code: typeof data?.code === 'string' ? data.code : 'ERROR',
    message: typeof data?.message === 'string' ? data.message : 'Something went wrong; please try again.',
  };
}
