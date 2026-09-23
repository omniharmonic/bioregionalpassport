import type { WalletDb, OutboxRow } from './db.js';
import { credentialsFor, isOnline, PodError } from './util.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  label?: string;
}

export type SendResult = { queued: false; status: number; body: any } | { queued: true; id: number };

/** Parses a JSON answer; anything else (e.g. an HTML 404 from a service that is not deployed) becomes one sentence. */
export async function readBody(res: Response): Promise<any> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return res.ok ? null : { code: 'HTTP_' + res.status, message: `The pod did not answer as expected (HTTP ${res.status}).` };
  try {
    return JSON.parse(text);
  } catch {
    return {
      code: res.status === 404 ? 'NOT_AVAILABLE' : 'BAD_RESPONSE',
      message: res.status === 404 ? 'This service is not available on this pod yet.' : `The pod did not answer as expected (HTTP ${res.status}).`,
    };
  }
}

/** Throws the server's `{ code, message, hint }` as a `PodError` for non-2xx answers. */
export function ensureOk(r: { status: number; body: any }): any {
  if (r.status >= 200 && r.status < 300) return r.body;
  const b = r.body ?? {};
  throw new PodError(r.status, typeof b.code === 'string' ? b.code : 'ERROR', typeof b.message === 'string' ? b.message : 'The pod refused this request.', typeof b.hint === 'string' ? b.hint : undefined);
}

/**
 * Every POST goes through `enqueue()`: the request is written to the IndexedDB outbox, sent at once when online,
 * and removed when the server answers. `durable` requests (relay messages of the offline ceremony: VRC halves and
 * witness requests) stay queued on a network failure and are retried by `flush()` when the device is back
 * online; non-durable requests (challenge-bound sign-in, apply, ack) are dropped and the error is thrown, because
 * their challenge expires after five minutes anyway.
 */
export class Outbox {
  constructor(
    private readonly db: WalletDb,
    private readonly fetchImpl: FetchLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async deliver(req: HttpRequest): Promise<{ status: number; body: any }> {
    const init: RequestInit = { method: req.method, headers: { accept: 'application/json', ...(req.headers ?? {}) }, credentials: credentialsFor(req.url) };
    if (req.body !== undefined) {
      init.body = JSON.stringify(req.body);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
    const res = await this.fetchImpl(req.url, init);
    return { status: res.status, body: await readBody(res) };
  }

  async enqueue(req: HttpRequest, opts: { durable?: boolean } = {}): Promise<SendResult> {
    const row: OutboxRow = { url: req.url, method: req.method, body: req.body ?? null, createdAt: this.now().toISOString(), attempts: 0 };
    if (req.headers) row.headers = req.headers;
    if (req.label) row.label = req.label;
    const id = (await this.db.outbox.add(row)) as number;
    if (!isOnline()) {
      if (opts.durable) return { queued: true, id };
      await this.db.outbox.delete(id);
      throw new PodError(0, 'OFFLINE', 'You appear to be offline; connect and try again.');
    }
    try {
      const r = await this.deliver(req);
      if (r.status >= 500 && opts.durable) {
        await this.db.outbox.update(id, { attempts: 1, lastError: String(r.body?.message ?? r.status) });
        return { queued: true, id };
      }
      await this.db.outbox.delete(id);
      return { queued: false, ...r };
    } catch (e) {
      if (opts.durable) {
        await this.db.outbox.update(id, { attempts: 1, lastError: e instanceof Error ? e.message : String(e) });
        return { queued: true, id };
      }
      await this.db.outbox.delete(id);
      throw new PodError(0, 'OFFLINE', 'You appear to be offline; connect and try again.');
    }
  }

  /** Sends one request without queueing (GETs). */
  async request(req: HttpRequest): Promise<{ status: number; body: any }> {
    try {
      return await this.deliver(req);
    } catch {
      throw new PodError(0, 'OFFLINE', 'You appear to be offline; connect and try again.');
    }
  }

  async pending(): Promise<OutboxRow[]> {
    return this.db.outbox.orderBy('id').toArray();
  }

  /**
   * Retries queued requests oldest first. A request the server answered (any status below 500) leaves the queue;
   * network failures and 5xx answers stay for the next flush. Stops at the first network failure.
   */
  async flush(): Promise<{ sent: number; failed: number; remaining: number }> {
    let sent = 0;
    let failed = 0;
    if (!isOnline()) return { sent, failed, remaining: await this.db.outbox.count() };
    for (const row of await this.pending()) {
      try {
        const r = await this.deliver({ url: row.url, method: row.method, ...(row.headers ? { headers: row.headers } : {}), body: row.body ?? undefined });
        if (r.status >= 500) {
          failed++;
          await this.db.outbox.update(row.id!, { attempts: row.attempts + 1, lastError: String(r.body?.message ?? r.status) });
          continue;
        }
        await this.db.outbox.delete(row.id!);
        if (r.status >= 400) failed++;
        else sent++;
      } catch (e) {
        failed++;
        await this.db.outbox.update(row.id!, { attempts: row.attempts + 1, lastError: e instanceof Error ? e.message : String(e) });
        break;
      }
    }
    return { sent, failed, remaining: await this.db.outbox.count() };
  }

  /** Flushes whenever the browser reports it is back online; returns an unsubscribe function. */
  autoFlush(target: { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void } = globalThis as any): () => void {
    const onOnline = () => void this.flush();
    target.addEventListener?.('online', onOnline);
    return () => target.removeEventListener?.('online', onOnline);
  }
}
