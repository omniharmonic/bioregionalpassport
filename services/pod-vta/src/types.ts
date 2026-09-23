import type { DataIntegrityProof, DidResolver, KeyPair } from '@passport/credential-core';
import type { Db } from '@passport/db';
import type { PodContext, Route } from '@passport/service-kit';
import type { BioregionManifest, TrustPolicy } from '@passport/tenant-config';
import type { Tier } from '@passport/vocab';
import type { ChallengeStore } from './challenges.js';
import type { RelayStore } from './relay.js';

/** Pod context as seen by the VTA (`db` already scoped by `withPod`). */
export type VtaContext = PodContext<BioregionManifest, TrustPolicy, Db>;
export type VtaRoute = Route<VtaContext>;

/**
 * Signs as the pod. Produced by the control plane's `loadPodSigner` (Task 9); in tests build one from
 * `generateKeyPair` + `signDocument`. `keyPair` is optional (only the control plane exposes it).
 */
export interface PodSigner {
  did: string;
  kid: string;
  keyPair?: KeyPair;
  sign<T extends object>(
    doc: T,
    opts?: { proofPurpose?: string; challenge?: string; domain?: string; created?: string },
  ): T & { proof: DataIntegrityProof };
}

/** The subset of a trust-index recommendation the PEP consumes. */
export interface TierRecommendationLike {
  tier: Tier;
  score?: number;
  explanation: string[];
  next?: { tier: Tier; missing: string[]; hints: string[] };
}

export interface IndexHooks {
  recommendTier(ctx: VtaContext, did: string): Promise<TierRecommendationLike>;
  /**
   * Accepted for the PEP → index weighting hook (`markWeighted`); the MVP PEP does not see endorsement
   * commitments yet, so it is not called here.
   */
  markWeighted?: (ctx: VtaContext, poster: string, commitments: readonly string[], weighted?: boolean) => Promise<number>;
}

export interface PodVtaDeps {
  podSigner: PodSigner;
  resolver: DidResolver;
  /** HMAC secret for gate sessions (≥ 32 bytes). */
  sessionSecret: string;
  /**
   * Platform database for `platform.relay_messages`. Must be a handle that can run while a `withPod`
   * transaction is open (a postgres.js pool). When absent, the relay uses an in-memory ring.
   */
  platformDb?: Db;
  index: IndexHooks;
  /** Override the challenge store (defaults to the process-wide in-memory store). */
  challenges?: ChallengeStore;
  /** Override the in-memory relay ring (used only when `platformDb` is absent). */
  relay?: RelayStore;
}
