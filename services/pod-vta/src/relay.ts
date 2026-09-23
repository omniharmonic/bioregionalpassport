import type { Db } from '@passport/db';
import { parseMessage } from '@passport/lexicons';
import { ServiceError } from '@passport/service-kit';
import type { VtaContext } from './types.js';
import { bad, isObject, json, toIso } from './util.js';

/** QR-derived channel ids: 16–128 url-safe characters (e.g. base64url of sha256 of the OOB challenge). */
export const CHANNEL_RE = /^[a-zA-Z0-9_-]{16,128}$/;
export const RELAY_TTL_MS = 24 * 60 * 60_000;
export const RELAY_PAGE = 100;
export const RELAY_MAX_BODY_BYTES = 64 * 1024;
/** A channel holds at most this many live (< 24 h) messages; further appends get 429 `CHANNEL_FULL`. */
export const RELAY_MAX_PER_CHANNEL = 500;

export interface RelayMessage {
  seq: number;
  sender: string;
  body: unknown;
  createdAt: string;
}

/** In-memory fallback ring (per process) used when no platform database is configured. */
export class RelayStore {
  private seq = 0;
  private readonly channels = new Map<string, RelayMessage[]>();

  append(channel: string, sender: string, body: unknown, now: Date): RelayMessage {
    const cutoff = now.getTime() - RELAY_TTL_MS;
    const list = (this.channels.get(channel) ?? []).filter((m) => Date.parse(m.createdAt) > cutoff);
    this.channels.set(channel, list);
    if (list.length >= RELAY_MAX_PER_CHANNEL) throw channelFull();
    const msg: RelayMessage = { seq: ++this.seq, sender, body, createdAt: now.toISOString() };
    list.push(msg);
    return msg;
  }

  list(channel: string, after: number, now: Date): RelayMessage[] {
    const cutoff = now.getTime() - RELAY_TTL_MS;
    return (this.channels.get(channel) ?? [])
      .filter((m) => m.seq > after && Date.parse(m.createdAt) > cutoff)
      .slice(0, RELAY_PAGE);
  }
}

export const defaultRelayStore = new RelayStore();

function channelFull(): ServiceError {
  return new ServiceError(429, 'CHANNEL_FULL', 'This relay channel is full; wait for older messages to expire or use a new channel.');
}

/** Ceremony messages only (B3 §5); payment messages travel through the gateway, not the relay. */
function checkBody(body: unknown): void {
  // Size first, so an oversized body is never parsed.
  let size: number;
  try {
    size = JSON.stringify(body ?? null).length;
  } catch {
    throw bad('BAD_MESSAGE', 'The relay only carries ceremony messages, and this one is not valid.');
  }
  if (size > RELAY_MAX_BODY_BYTES) throw new ServiceError(413, 'TOO_LARGE', 'This relay message is too large.');
  let type: string;
  try {
    type = parseMessage(body).type;
  } catch {
    throw bad('BAD_MESSAGE', 'The relay only carries ceremony messages, and this one is not valid.');
  }
  if (type.startsWith('org.bioregion.pay.')) throw bad('BAD_MESSAGE', 'The relay only carries ceremony messages, not payments.');
}

function checkChannel(channel: string | undefined): string {
  if (!channel || !CHANNEL_RE.test(channel)) {
    throw bad('BAD_CHANNEL', 'The relay channel must be 16 to 128 letters, digits, dashes or underscores.');
  }
  return channel;
}

/** Channels are namespaced by pod in storage so two pods never share a channel. */
const key = (ctx: VtaContext, channel: string) => `${ctx.slug}:${channel}`;

export interface RelayBackend {
  platformDb?: Db;
  relay: RelayStore;
}

/**
 * ADR-22 relay append. With a platform database the message goes to `platform.relay_messages`
 * (`seq` is the table's identity, so ordering is strict per channel); otherwise to the in-memory ring.
 */
export async function relayAppend(ctx: VtaContext, backend: RelayBackend, channelParam: string | undefined, input: unknown): Promise<{ seq: number; createdAt: string }> {
  const channel = checkChannel(channelParam);
  if (!isObject(input) || typeof input['sender'] !== 'string' || !input['sender'] || input['sender'].length > 512) {
    throw bad('BAD_REQUEST', 'A relay message needs a sender and a body.');
  }
  const body = input['body'];
  checkBody(body);
  const now = ctx.now();
  if (backend.platformDb) {
    const k = key(ctx, channel);
    const cutoff = new Date(now.getTime() - RELAY_TTL_MS).toISOString();
    await backend.platformDb.query('DELETE FROM platform.relay_messages WHERE channel = $1 AND created_at <= $2', [k, cutoff]);
    const [count] = await backend.platformDb.query<{ n: number | string }>('SELECT count(*) AS n FROM platform.relay_messages WHERE channel = $1', [k]);
    if (Number(count?.n ?? 0) >= RELAY_MAX_PER_CHANNEL) throw channelFull();
    const [row] = await backend.platformDb.query<{ seq: string | number; created_at: unknown }>(
      `INSERT INTO platform.relay_messages (channel, sender, body, created_at) VALUES ($1, $2, $3, $4) RETURNING seq, created_at`,
      [k, input['sender'], JSON.stringify(body), now.toISOString()],
    );
    return { seq: Number(row!.seq), createdAt: toIso(row!.created_at)! };
  }
  const msg = backend.relay.append(key(ctx, channel), input['sender'], body, now);
  return { seq: msg.seq, createdAt: msg.createdAt };
}

/** ADR-22 relay list: messages after `seq`, oldest first, ignoring anything older than 24 h. */
export async function relayList(ctx: VtaContext, backend: RelayBackend, channelParam: string | undefined, afterParam: string | undefined): Promise<{ messages: RelayMessage[] }> {
  const channel = checkChannel(channelParam);
  const after = afterParam === undefined || afterParam === '' ? 0 : Number(afterParam);
  if (!Number.isInteger(after) || after < 0) throw bad('BAD_REQUEST', '"after" must be a non-negative sequence number.');
  const now = ctx.now();
  if (backend.platformDb) {
    const rows = await backend.platformDb.query<{ seq: string | number; sender: string; body: unknown; created_at: unknown }>(
      `SELECT seq, sender, body, created_at FROM platform.relay_messages
        WHERE channel = $1 AND seq > $2 AND created_at > $3
        ORDER BY seq ASC LIMIT ${RELAY_PAGE}`,
      [key(ctx, channel), after, new Date(now.getTime() - RELAY_TTL_MS).toISOString()],
    );
    return {
      messages: rows.map((r) => ({ seq: Number(r.seq), sender: r.sender, body: json(r.body), createdAt: toIso(r.created_at)! })),
    };
  }
  return { messages: backend.relay.list(key(ctx, channel), after, now) };
}
