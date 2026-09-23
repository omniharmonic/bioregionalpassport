import type { DidResolver } from '@passport/credential-core';
import type { Db } from '@passport/db';
import type { PodContext, Route } from '@passport/service-kit';
import type { BioregionManifest, TrustPolicy } from '@passport/tenant-config';

export type RoundContext = PodContext<BioregionManifest, TrustPolicy, Db>;
export type RoundRoute = Route<RoundContext>;

export interface RoundDeps {
  /** Resolves the ballot `did:key`s (inline) and, for group votes, the pod `did:web`. */
  resolver: DidResolver;
  /**
   * Fetches a status list named by a credential's `BitstringStatusListEntry` (for group presentations, so a
   * revoked group VAC or delegation is refused). Same contract as verifier-sdk `StatusFetch`, plus the pod
   * context (pod-vta serves its own lists). When absent, status lists are not checked.
   */
  statusFetch?: (url: string, ctx: RoundContext) => Promise<unknown>;
}

export type RoundStatus = 'draft' | 'open' | 'tallying' | 'published';
export const ROUND_STATUSES: readonly RoundStatus[] = ['draft', 'open', 'tallying', 'published'];

export interface Eligibility {
  proposeTier: string;
  voteTier: string;
  voiceBudget: number;
  matchingCap?: number;
}
