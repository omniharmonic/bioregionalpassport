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

const dbDist = new URL('../packages/db/dist/index.js', import.meta.url);
const controlPlaneDist = new URL('../services/control-plane/dist/index.js', import.meta.url);

const { createTestDb } = await import(dbDist);
const { tenantZeroJob, DEFAULT_PLATFORM_DOMAIN } = await import(controlPlaneDist);

const platformDomain = process.env.PLATFORM_DOMAIN || DEFAULT_PLATFORM_DOMAIN;
// 64 hex chars = 32 bytes, the shape `POD_KEY_ENCRYPTION_KEY` requires (AES-256-GCM key).
const masterKey = randomBytes(32).toString('hex');

console.log(`Tenant-zero job starting against an in-memory PGlite database (platformDomain=${platformDomain}).`);

const db = await createTestDb();
let report;
try {
  report = await tenantZeroJob(db, platformDomain, masterKey);
} finally {
  await db.close();
}

console.log(JSON.stringify(report, null, 2));

const outPath = fileURLToPath(new URL('../tenant-zero-report.json', import.meta.url));
await writeFile(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`Report written to ${outPath}`);

if (!report.ok) {
  console.error('Tenant-zero verification failed: one or more checks did not pass.');
  process.exit(1);
}

console.log('Tenant-zero provision + verify: OK.');
