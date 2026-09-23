import type { DidResolver } from '@passport/credential-core';
import type { Db } from '@passport/db';
import type { PodContext, Route } from '@passport/service-kit';
import type { BioregionManifest, TrustPolicy } from '@passport/tenant-config';

export type RoundContext = PodContext<BioregionManifest, TrustPolicy, Db>;
export type RoundRoute = Route<RoundContext>;

export interface RoundDeps {
  /** Resolves the ballot `did:key`s (inline) and, for group votes, the pod `did:web`. */
  resolver: DidResolver;
}

export type RoundStatus = 'draft' | 'open' | 'tallying' | 'published';
export const ROUND_STATUSES: readonly RoundStatus[] = ['draft', 'open', 'tallying', 'published'];

export interface Eligibility {
  proposeTier: string;
  voteTier: string;
  voiceBudget: number;
  matchingCap?: number;
}
