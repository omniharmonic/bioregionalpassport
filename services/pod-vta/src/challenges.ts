import { randomNonce } from '@passport/credential-core';
import { ServiceError } from '@passport/service-kit';

export const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 10_000;

export interface IssuedChallenge {
  challenge: string;
  domain: string;
  expiresAt: string;
}

interface Entry {
  slug: string;
  domain: string;
  expiresAt: number;
}

/**
 * Single-use sign-in challenges (B3 §10: presentations are bound to a fresh challenge + domain).
 *
 * Storage decision: an in-memory Map keyed by the challenge, remembering the pod slug and domain, with a
 * 5-minute lifetime measured on the pod context's clock. This is enough for one long-lived process (tests,
 * `next start`, the in-process control-plane smoke). On a multi-instance serverless deployment a challenge
 * fetched from one instance may be consumed on another; the follow-up is to persist challenges in
 * `platform.relay_messages` under channel `challenge:<slug>` (the table already has what is needed).
 */
export class ChallengeStore {
  private readonly entries = new Map<string, Entry>();

  issue(slug: string, domain: string, now: Date): IssuedChallenge {
    this.sweep(now.getTime());
    const challenge = randomNonce();
    const expiresAt = now.getTime() + CHALLENGE_TTL_MS;
    this.entries.set(challenge, { slug, domain, expiresAt });
    return { challenge, domain, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Consumes `challenge` for pod `slug`: returns its domain, or throws 401 `BAD_CHALLENGE` when it is unknown,
   * belongs to another pod, was already used, or has expired. A challenge is removed on first use either way.
   */
  consume(slug: string, challenge: unknown, now: Date): { challenge: string; domain: string } {
    if (typeof challenge !== 'string' || !challenge) {
      throw new ServiceError(401, 'BAD_CHALLENGE', 'This presentation does not answer a challenge from this pod.', 'Fetch GET /challenge and sign again.');
    }
    const entry = this.entries.get(challenge);
    if (!entry || entry.slug !== slug) {
      throw new ServiceError(401, 'BAD_CHALLENGE', 'This challenge was not issued by this pod or has already been used.', 'Fetch GET /challenge and sign again.');
    }
    this.entries.delete(challenge);
    if (entry.expiresAt <= now.getTime()) {
      throw new ServiceError(401, 'BAD_CHALLENGE', 'This challenge has expired.', 'Fetch GET /challenge and sign again.');
    }
    return { challenge, domain: entry.domain };
  }

  private sweep(now: number): void {
    for (const [k, v] of this.entries) if (v.expiresAt <= now) this.entries.delete(k);
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/** Process-wide default store. */
export const defaultChallengeStore = new ChallengeStore();

export const podDomain = (ctx: { slug: string; platformDomain: string }): string => `${ctx.slug}.${ctx.platformDomain}`;
