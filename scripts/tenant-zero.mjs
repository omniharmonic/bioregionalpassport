#!/usr/bin/env node
// Provisions and verifies the "tenant zero" pod on an in-memory PGlite database, as a smoke test
// for multi-tenancy (B2 §2.1, MVP plan Task 16). Requires no secrets and touches no real database:
// the master key below only encrypts a pod signing key that lives for the duration of this process.
//
// Usage: node scripts/tenant-zero.mjs
// Requires the workspace to be built first (`pnpm -r build`) so `dist/` exists for each package.
//
// Imports by relative path to each package's build output rather than by bare `@passport/*`
// specifier: this script is not itself a workspace member, so plain Node module resolution would
// not find `@passport/*` in any node_modules directory above it.

import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dist = (path) => new URL(`../${path}/dist/index.js`, import.meta.url);

const { createTestDb } = await import(dist('packages/db'));
const { tenantZeroJob, DEFAULT_PLATFORM_DOMAIN } = await import(dist('services/control-plane'));
// The real smoke hooks: the VTA ceremony back half, a 1-credit ledger transfer and an AppView record round trip,
// plus the demo-record seeder. Every one is required: the job runs with failOnSkipped, so a missing hook fails CI.
const { ceremonyBackHalf } = await import(dist('services/pod-vta'));
const { smokeTransfer } = await import(dist('services/cc-gateway'));
const { smokeRecord, seedDemoRecords } = await import(dist('services/appview'));
const deps = {
  vta: { ceremonyBackHalf },
  gateway: { smokeTransfer },
  appview: { smokeRecord, seedRecords: seedDemoRecords },
  seedRecords: seedDemoRecords,
};

const platformDomain = process.env.PLATFORM_DOMAIN || DEFAULT_PLATFORM_DOMAIN;
// 64 hex chars = 32 bytes, the shape `POD_KEY_ENCRYPTION_KEY` requires (AES-256-GCM key).
const masterKey = randomBytes(32).toString('hex');

console.log(`Tenant-zero job starting against an in-memory PGlite database (platformDomain=${platformDomain}).`);

const db = await createTestDb();
let report;
try {
  report = await tenantZeroJob(db, platformDomain, masterKey, deps, { failOnSkipped: true });
} finally {
  await db.close();
}

console.log(JSON.stringify(report, null, 2));

const outPath = fileURLToPath(new URL('../tenant-zero-report.json', import.meta.url));
await writeFile(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`Report written to ${outPath}`);

if (!report.ok) {
  console.error('Tenant-zero verification failed: one or more checks did not pass (skipped checks count as failures here).');
  process.exit(1);
}

console.log('Tenant-zero provision + verify: OK.');
