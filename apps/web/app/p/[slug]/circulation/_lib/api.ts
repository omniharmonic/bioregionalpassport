/**
 * Browser-side calls to the pod's services (`/api/gateway`, `/api/appview`, `/api/vta`). The session cookie
 * rides along (same origin); `x-pod` names the pod so the calls work on the platform host (`/p/<slug>`) as
 * well as on the pod's own host. Every failure carries the server's one-sentence `message`.
 */

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; code: string; message: string };

export async function api<T>(slug: string, path: string, init: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { 'x-pod': slug, accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      headers,
      credentials: 'include',
      cache: 'no-store',
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    return { ok: false, status: 0, code: 'OFFLINE', message: 'We could not reach the pod; check your connection and try again.' };
  }
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (res.ok) return { ok: true, status: res.status, data: payload as T };
  const p = (payload ?? {}) as { code?: unknown; message?: unknown };
  return {
    ok: false,
    status: res.status,
    code: typeof p.code === 'string' ? p.code : 'ERROR',
    message: typeof p.message === 'string' ? p.message : 'Something went wrong on our side; please try again.',
  };
}

/** Gateway path helper: `gw('/accounts/me')` → `/api/gateway/accounts/me`. */
export const gw = (path: string): string => `/api/gateway${path}`;

// ── response shapes (subset of what cc-gateway returns) ─────────────────────────────────────────────

export interface AccountView {
  did: string;
  kind: string;
  band: string | null;
  balance: number;
  limit: number;
  available: number;
  unit: string;
  openedAt: string | null;
}

export interface StatementEntry {
  id: string;
  direction: 'in' | 'out';
  payer: string | null;
  payee: string | null;
  amount: number;
  unit: string | null;
  invoice: string | null;
  totalSale: { unit: string; value: number } | null;
  createdAt: string | null;
  status: string;
  receiptId: string | null;
  tender: string | null;
}

export interface Rules {
  maxShare: number;
  category: string;
  minSale: number;
  ceiling: number;
  offlineAllowance: number;
}

export interface MyEnterprise {
  did: string;
  name: string;
  role: 'owner' | 'staff';
  categories: string[] | null;
  rules: Rules | null;
  account: AccountView | null;
  exposure: { balance: number; ceiling: number; pct: number };
  commitment: { id: string; text: string; signedAt: string | null } | null;
  staff?: { staffDid: string; digest: string; validUntil: string | null; revokedAt: string | null }[];
}

export interface PendingTender {
  transactionId: string;
  invoice: string | null;
  payee: string | null;
  amount: { unit: string; value: number };
  totalSale: { unit: string; value: number } | null;
  dollarsDue: number | null;
  createdAt: string | null;
}

export interface Receipt {
  type?: string;
  transactionId?: string;
  invoice?: string;
  payer?: string;
  payee?: string;
  amount?: { unit: string; value: number };
  totalSale?: { unit: string; value: number };
  createdAt?: string;
  posWriteBack?: { status?: string; provider?: string; ref?: string };
  [k: string]: unknown;
}

export interface ReceiptView {
  receipt: Receipt;
  externalTender: { provider?: string; ref?: string; dollars?: number; status?: string; recordedAt?: string } | null;
  createdAt: string | null;
}

export interface DirectoryEntry {
  uri: string;
  record: { name?: string; did?: string; categories?: string[]; acceptanceShare?: number; description?: string; [k: string]: unknown };
  offerCount: number;
  needCount: number;
}

/** Enterprise DID → name, from the open directory (for statement counterparties). */
export function enterpriseNames(entries: DirectoryEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) if (typeof e.record.did === 'string' && typeof e.record.name === 'string') out[e.record.did] = e.record.name;
  return out;
}
