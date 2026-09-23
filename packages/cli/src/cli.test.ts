import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '@passport/db';
import { boulderManifest } from '@passport/tenant-config';
import { importOptional, loadServiceDeps, parseDotEnv, run, type CliIo } from './index.js';

let db: Db;
let out: string[];
let err: string[];
const env = { POD_KEY_ENCRYPTION_KEY: 'ab'.repeat(32), PLATFORM_DOMAIN: 'bioregionalpassport.org' };

beforeEach(async () => {
  db = await createTestDb();
  out = [];
  err = [];
});
afterEach(async () => {
  await db.close();
});

const io = (extra: Partial<CliIo> = {}): CliIo => ({
  env,
  stdout: (s) => out.push(s),
  stderr: (s) => err.push(s),
  openDb: () => db,
  closeDb: false,
  loadDeps: async () => ({}),
  ...extra,
});

describe('passport CLI', () => {
  it('creates tenant-zero idempotently, lists, verifies and exports', async () => {
    expect(await run(['bioregion', 'create', '--manifest', 'tenant-zero'], io())).toBe(0);
    expect(out.join('\n')).toMatch(/did:web:bioregionalpassport\.org:dids:tenant-zero/);
    expect(out.join('\n')).toMatch(/pod-key\s+created/);
    out = [];
    expect(await run(['bioregion', 'create', '--manifest', 'tenant-zero'], io())).toBe(0);
    expect(out.join('\n')).toMatch(/Nothing to apply/);

    out = [];
    expect(await run(['bioregion', 'list'], io())).toBe(0);
    expect(out.join('\n')).toMatch(/tenant-zero\s+active/);

    out = [];
    expect(await run(['bioregion', 'verify', 'tenant-zero'], io())).toBe(0);
    expect(out.join('\n')).toMatch(/All checks passed\. 3 checks skipped\./);

    out = [];
    expect(await run(['bioregion', 'export', 'tenant-zero'], io())).toBe(0);
    const bundle = JSON.parse(out.join('\n'));
    expect(bundle.tables.policy_versions).toHaveLength(1);
  });

  it('creates from a manifest file with --json output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'passport-cli-'));
    await writeFile(join(dir, 'boulder.json'), JSON.stringify(boulderManifest));
    expect(await run(['bioregion', 'create', '--manifest', 'boulder.json', '--json'], io({ cwd: dir }))).toBe(0);
    const result = JSON.parse(out.join('\n'));
    expect(result.slug).toBe('boulder');
    expect(result.manifest.proof).toBeDefined();
  });

  it('explains missing configuration and bad input', async () => {
    expect(await run(['bioregion', 'create', '--manifest', 'tenant-zero'], io({ env: {} }))).toBe(2);
    expect(err.join('\n')).toMatch(/POD_KEY_ENCRYPTION_KEY is not set/);
    err = [];
    expect(await run(['bioregion', 'create'], io())).toBe(2);
    expect(err.join('\n')).toMatch(/needs --manifest/);
    err = [];
    expect(await run(['bioregion', 'frobnicate'], io())).toBe(2);
    expect(await run(['bioregion', 'export', 'nope'], io())).toBe(1);
    expect(err.join('\n')).toMatch(/not provisioned/);
    expect(await run(['bioregion', 'verify', 'nope'], io())).toBe(1);
  });

  it('runs platform migrate', async () => {
    expect(await run(['platform', 'migrate'], io())).toBe(0);
  });
});

describe('parseDotEnv', () => {
  it('parses keys, quotes, comments and export prefixes', () => {
    expect(
      parseDotEnv(`# comment\nA=1\nexport B="two words"\nC='x#y'\nD=plain # trailing\n\nbad line\nE=`),
    ).toEqual({ A: '1', B: 'two words', C: 'x#y', D: 'plain', E: '' });
  });
});

describe('importOptional', () => {
  const notFound = (msg: string) => Object.assign(new Error(msg), { code: 'ERR_MODULE_NOT_FOUND' });

  it('returns undefined only when the exact package is missing', async () => {
    expect(await importOptional('@passport/nope', async () => { throw notFound("Cannot find package '@passport/nope' imported from /x/cli.js"); })).toBeUndefined();
    expect(await importOptional('node:path')).toBeDefined();
  });

  it('rethrows a missing transitive dependency or any other load error', async () => {
    await expect(
      importOptional('@passport/appview', async () => { throw notFound("Cannot find package 'zod' imported from /x/appview/dist/index.js"); }),
    ).rejects.toThrow(/zod/);
    await expect(importOptional('@passport/appview', async () => { throw new SyntaxError('bad build'); })).rejects.toThrow(/bad build/);
  });

  it('really reports a missing package as not found', async () => {
    expect(await importOptional('@passport/definitely-not-installed')).toBeUndefined();
  });
});

describe('verify output', () => {
  it('exits non-zero only when a check fails', async () => {
    await run(['bioregion', 'create', '--manifest', 'boulder'], io());
    out = [];
    await db.query("update platform.pods set manifest = jsonb_set(manifest, '{identity,name}', '\"Evil\"') where slug = 'boulder'");
    expect(await run(['bioregion', 'verify', 'boulder'], io())).toBe(1);
    expect(out.join('\n')).toMatch(/1 check failed\. 3 checks skipped\./);
  });

  it('create --allow-downgrade permits removing an anchor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'passport-cli-'));
    const withA = { ...boulderManifest, governance: { ...boulderManifest.governance, anchors: ['did:key:zA'] } };
    await writeFile(join(dir, 'a.json'), JSON.stringify(withA));
    await writeFile(join(dir, 'b.json'), JSON.stringify(boulderManifest));
    expect(await run(['bioregion', 'create', '--manifest', 'a.json'], io({ cwd: dir }))).toBe(0);
    expect(await run(['bioregion', 'create', '--manifest', 'b.json'], io({ cwd: dir }))).toBe(1);
    expect(err.join('\n')).toMatch(/did:key:zA/);
    expect(await run(['bioregion', 'create', '--manifest', 'b.json', '--allow-downgrade'], io({ cwd: dir }))).toBe(0);
  });
});

describe('loadServiceDeps', () => {
  it('wires the installed service smoke hooks, including gateway.smokeTransfer', async () => {
    const deps = await loadServiceDeps();
    expect(typeof deps.seedRecords).toBe('function');
    expect(typeof deps.appview?.smokeRecord).toBe('function');
    expect(typeof deps.vta?.ceremonyBackHalf).toBe('function');
    expect(typeof deps.gateway?.smokeTransfer).toBe('function');
  });
});
