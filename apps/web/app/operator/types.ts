import type { BioregionManifest, TrustPolicy } from '@passport/tenant-config';

export interface PlatformHealth {
  pendingMigrations: string[];
  platformMigrationFiles: number;
}

export interface TenantZeroRun {
  id: string;
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean | null;
  report: unknown;
}

export interface PodHealthSummary {
  slug: string;
  did: string;
  name: string;
  status: string;
  members: Record<string, number>;
  membersTotal: number;
  events: number;
  pendingMigrations: string[];
  error?: string;
}

export interface PodHealthDetail extends PodHealthSummary {
  manifest: BioregionManifest;
  policy: TrustPolicy | null;
}

export interface HealthListResponse {
  ok: boolean;
  platform: PlatformHealth;
  lastTenantZeroRun: TenantZeroRun | null;
  pods: PodHealthSummary[];
}

export interface HealthDetailResponse {
  ok: boolean;
  platform: PlatformHealth;
  lastTenantZeroRun: TenantZeroRun | null;
  pod: PodHealthDetail;
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  skipped?: boolean;
  detail?: string;
}

export interface VerifyReport {
  ok: boolean;
  slug: string;
  did?: string;
  skipped: number;
  startedAt: string;
  finishedAt: string;
  checks: VerifyCheck[];
}

export interface ProvisionStep {
  name: string;
  status: string;
  detail?: string;
}

export interface ProvisionResult {
  slug: string;
  did: string;
  manifest: BioregionManifest;
  steps: ProvisionStep[];
}
