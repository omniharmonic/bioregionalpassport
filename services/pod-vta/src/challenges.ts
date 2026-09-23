import { randomNonce } from '@passport/credential-core';
import type { Db } from '@passport/db';
import { ServiceError } from '@passport/service-kit';

export const CHALLENGE_TTL_MS = 5 * 60_000;

export interface IssuedChallenge {
  challenge: string;
  domain: string;
  expiresAt: string;
}

/**
 * Single-use sign-in challenges (B3 §10: presentations are bound to a fresh challenge + domain), 5-minute
 * lifetime on the pod context's clock. Challenges expire by time only; there is no size-based eviction, so a
 * flood of `GET /challenge` cannot push out legitimate challenges.
 */
export interface ChallengeStore {
  issue(slug: string, domain: string, now: Date): Promise<IssuedChallenge>;
  /**
   * Consumes `challenge` for pod `slug` and returns its domain, or throws 401 `BAD_CHALLENGE` when it is unknown,
   * belongs to another pod, was already used, or has expired.
   */
  consume(slug: string, challenge: unknown, now: Date): Promise<{ challenge: string; domain: string }>;
}

const HINT = 'Fetch GET /challenge and sign again.';
const refuse = (message: string) => new ServiceError(401, 'BAD_CHALLENGE', message, HINT);
const UNKNOWN = 'This challenge was not issued by this pod or has already been used.';

function checkShape(challenge: unknown): string {
  if (typeof challenge !== 'string' || !challenge) throw refuse('This presentation does not answer a challenge from this pod.');
  return challenge;
}

/** In-process store: the fallback when no platform database is configured (tests, single-process runs). */
export class MemoryChallengeStore implements ChallengeStore {
  private readonly entries = new Map<string, { slug: string; domain: string; expiresAt: number }>();

  async issue(slug: string, domain: string, now: Date): Promise<IssuedChallenge> {
    const t = now.getTime();
    for (const [k, v] of this.entries) if (v.expiresAt <= t) this.entries.delete(k);
    const challenge = randomNonce();
    const expiresAt = t + CHALLENGE_TTL_MS;
    this.entries.set(challenge, { slug, domain, expiresAt });
    return { challenge, domain, expiresAt: new Date(expiresAt).toISOString() };
  }

  async consume(slug: string, input: unknown, now: Date): Promise<{ challenge: string; domain: string }> {
    const challenge = checkShape(input);
    const entry = this.entries.get(challenge);
    if (!entry || entry.slug !== slug) throw refuse(UNKNOWN);
    this.entries.delete(challenge);
    if (entry.expiresAt <= now.getTime()) throw refuse('This challenge has expired.');
    return { challenge, domain: entry.domain };
  }
}

/**
 * Persistent store in `platform.relay_messages`, channel `challenge:<slug>` (relay channels are stored as
 * `<slug>:<channel>` with no colon allowed in the channel id, so clients can never write here), body
 * `{ challenge, domain, expiresAt, usedAt? }`. Single use is enforced atomically by
 * `UPDATE … WHERE NOT (body ? 'usedAt') RETURNING`. Works across serverless instances. `db` must be a handle
 * usable while a `withPod` transaction is open (a separate pool).
 */
export class DbChallengeStore implements ChallengeStore {
  constructor(private readonly db: Db) {}

  async issue(slug: string, domain: string, now: Date): Promise<IssuedChallenge> {
    const channel = `challenge:${slug}`;
    const challenge = randomNonce();
    const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString();
    // Housekeeping by time only: drop challenges that expired more than a day ago.
    await this.db.query(`DELETE FROM platform.relay_messages WHERE channel = $1 AND created_at < $2`, [
      channel,
      new Date(now.getTime() - 86_400_000).toISOString(),
    ]);
    await this.db.query(`INSERT INTO platform.relay_messages (channel, sender, body, created_at) VALUES ($1, 'vta', $2, $3)`, [
      channel,
      JSON.stringify({ challenge, domain, expiresAt }),
      now.toISOString(),
    ]);
    return { challenge, domain, expiresAt };
  }

  async consume(slug: string, input: unknown, now: Date): Promise<{ challenge: string; domain: string }> {
    const challenge = checkShape(input);
    const rows = await this.db.query<{ body: unknown }>(
      `UPDATE platform.relay_messages SET body = body || jsonb_build_object('usedAt', $3::text)
        WHERE channel = $1 AND body->>'challenge' = $2 AND NOT (body ? 'usedAt')
        RETURNING body`,
      [`challenge:${slug}`, challenge, now.toISOString()],
    );
    const row = rows[0];
    if (!row) throw refuse(UNKNOWN);
    const body = (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as { domain: string; expiresAt: string };
    if (Date.parse(body.expiresAt) <= now.getTime()) throw refuse('This challenge has expired.');
    return { challenge, domain: body.domain };
  }
}

/** Process-wide fallback store. */
export const defaultChallengeStore: ChallengeStore = new MemoryChallengeStore();

export const podDomain = (ctx: { slug: string; platformDomain: string }): string => `${ctx.slug}.${ctx.platformDomain}`;
