import { parseMessage } from '@passport/lexicons';
import { PodError } from './util.js';

/** Same rule as pod-vta's `CHANNEL_RE`. */
export const CHANNEL_RE = /^[a-zA-Z0-9_-]{16,128}$/;

export interface RelayMessage {
  seq: number;
  sender: string;
  body: any;
  createdAt: string;
}

/** The ceremony transport (ADR-22): the pod VTA's HTTP relay in production, a Map in tests. */
export interface RelayTransport {
  /** Appends `body` to `channel`. `queued` = held in the outbox until the device is online. */
  post(channel: string, sender: string, body: unknown): Promise<{ seq?: number; queued?: boolean }>;
  /** Messages after `after` (exclusive), oldest first. */
  list(channel: string, after?: number): Promise<RelayMessage[]>;
}

/** In-memory relay with the server's validation rules (tests, and anything that runs both sides in one process). */
export class MemoryRelay implements RelayTransport {
  private seq = 0;
  readonly channels = new Map<string, RelayMessage[]>();

  async post(channel: string, sender: string, body: unknown): Promise<{ seq: number }> {
    if (!CHANNEL_RE.test(channel)) throw new PodError(400, 'BAD_CHANNEL', 'The relay channel must be 16 to 128 letters, digits, dashes or underscores.');
    try {
      parseMessage(body);
    } catch {
      throw new PodError(400, 'BAD_MESSAGE', 'The relay only carries ceremony messages, and this one is not valid.');
    }
    const msg: RelayMessage = { seq: ++this.seq, sender, body: JSON.parse(JSON.stringify(body)), createdAt: new Date().toISOString() };
    const list = this.channels.get(channel) ?? [];
    list.push(msg);
    this.channels.set(channel, list);
    return { seq: msg.seq };
  }

  async list(channel: string, after = 0): Promise<RelayMessage[]> {
    return (this.channels.get(channel) ?? []).filter((m) => m.seq > after);
  }
}
