import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  exportPod,
  provisionPod,
  verifyPod,
  DEFAULT_PLATFORM_DOMAIN,
  type ProvisionDeps,
  type VerifyDeps,
} from '@passport/control-plane';
import { createDb, listPods, migratePlatform, type Db } from '@passport/db';
import { boulderManifest, tenantZeroManifest } from '@passport/tenant-config';
import { formatChecks, formatRows, formatSteps } from './format.js';

export interface CliIo {
  env?: Record<string, string | undefined>;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Opens the database; defaults to postgres.js `createDb(DATABASE_URL)`. */
  openDb?: (url: string | undefined) => Db | Promise<Db>;
  /** Whether `run` closes the db it opened (default true). */
  closeDb?: boolean;
  /** Optional service modules; defaults to best-effort dynamic imports. */
  loadDeps?: () => Promise<ProvisionDeps & VerifyDeps>;
  cwd?: string;
}

export const USAGE = `passport — Bioregional Passport operator CLI

Usage:
  passport bioregion create --manifest <file|boulder|tenant-zero> [--json]
  passport bioregion verify <slug> [--json]
  passport bioregion export <slug>          (JSON bundle to stdout)
  passport bioregion list [--json]
  passport platform migrate

Environment (also read from <repo>/.env):
  DATABASE_URL              Postgres connection string
  POD_KEY_ENCRYPTION_KEY    64 hex chars; encrypts pod signing keys (create, verify)
  PLATFORM_DOMAIN           default ${DEFAULT_PLATFORM_DOMAIN}
`;

class UsageError extends Error {}

const BUILT_IN: Record<string, unknown> = { boulder: boulderManifest, 'tenant-zero': tenantZeroManifest };

async function importOptional(name: string): Promise<any> {
  try {
    const specifier = name; // variable specifier: these services are optional at build time
    return await import(specifier);
  } catch {
    return undefined;
  }
}

/** Best-effort discovery of the optional service packages (appview seeder + smoke hooks). */
export async function loadServiceDeps(): Promise<ProvisionDeps & VerifyDeps> {
  const [appview, vta, gateway] = await Promise.all([
    importOptional('@passport/appview'),
    importOptional('@passport/pod-vta'),
    importOptional('@passport/cc-gateway'),
  ]);
  return {
    ...(typeof appview?.seedDemoRecords === 'function' ? { seedRecords: appview.seedDemoRecords } : {}),
    ...(appview ? { appview } : {}),
    ...(vta ? { vta } : {}),
    ...(gateway ? { gateway } : {}),
  };
}

async function loadManifest(arg: string, cwd: string): Promise<unknown> {
  if (arg in BUILT_IN) return BUILT_IN[arg];
  const text = await readFile(resolve(cwd, arg), 'utf8').catch(() => {
    throw new UsageError(`Could not read manifest file ${arg}.`);
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`Manifest file ${arg} is not valid JSON.`);
  }
}

/** Runs the CLI; returns the process exit code. */
export async function run(argv: string[], io: CliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.stdout ?? ((s: string) => process.stdout.write(s.endsWith('\n') ? s : s + '\n'));
  const err = io.stderr ?? ((s: string) => process.stderr.write(s.endsWith('\n') ? s : s + '\n'));
  const cwd = io.cwd ?? process.cwd();

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { manifest: { type: 'string', short: 'm' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (e) {
    err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [group, command, arg] = positionals;
  if (values.help || !group) {
    out(USAGE);
    return values.help ? 0 : 2;
  }

  const platformDomain = env['PLATFORM_DOMAIN'] || DEFAULT_PLATFORM_DOMAIN;
  const masterKey = () => {
    const k = env['POD_KEY_ENCRYPTION_KEY'];
    if (!k) throw new UsageError('POD_KEY_ENCRYPTION_KEY is not set (64 hex characters).');
    return k;
  };

  let db: Db | undefined;
  const openDb = async (): Promise<Db> => {
    if (io.openDb) return (db = await io.openDb(env['DATABASE_URL']));
    const url = env['DATABASE_URL'];
    if (!url) throw new UsageError('DATABASE_URL is not set.');
    return (db = createDb(url));
  };

  try {
    const key = `${group} ${command ?? ''}`.trim();
    switch (key) {
      case 'platform migrate': {
        await migratePlatform(await openDb());
        out('Platform schema is up to date.');
        return 0;
      }
      case 'bioregion create': {
        if (!values.manifest) throw new UsageError('bioregion create needs --manifest <file|boulder|tenant-zero>.');
        const manifest = await loadManifest(values.manifest, cwd);
        const k = masterKey();
        const d = await openDb();
        await migratePlatform(d);
        const deps = await (io.loadDeps ?? loadServiceDeps)();
        const started = Date.now();
        const result = await provisionPod({
          manifest,
          db: d,
          platformDomain,
          masterKey: k,
          ...(deps.seedRecords ? { deps: { seedRecords: deps.seedRecords } } : {}),
        });
        if (values.json) out(JSON.stringify(result, null, 2));
        else {
          out(`Pod ${result.slug}  ${result.did}`);
          out(formatSteps(result.steps));
          const changed = result.steps.filter((s) => s.status !== 'unchanged').length;
          out(`${changed === 0 ? 'Nothing to apply' : `${changed} step(s) applied`} in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
        }
        return 0;
      }
      case 'bioregion verify': {
        if (!arg) throw new UsageError('bioregion verify needs a pod slug.');
        const k = masterKey();
        const d = await openDb();
        const deps = await (io.loadDeps ?? loadServiceDeps)();
        const report = await verifyPod({
          db: d,
          slug: arg,
          platformDomain,
          masterKey: k,
          deps: { vta: deps.vta, gateway: deps.gateway, appview: deps.appview },
        });
        if (values.json) out(JSON.stringify(report, null, 2));
        else {
          out(`Verify ${arg}${report.did ? `  ${report.did}` : ''}`);
          out(formatChecks(report.checks));
          out(report.ok ? 'All checks passed.' : 'Some checks failed.');
        }
        return report.ok ? 0 : 1;
      }
      case 'bioregion export': {
        if (!arg) throw new UsageError('bioregion export needs a pod slug.');
        const bundle = await exportPod(await openDb(), arg);
        out(JSON.stringify(bundle, null, 2));
        return 0;
      }
      case 'bioregion list': {
        const pods = await listPods(await openDb());
        if (values.json) out(JSON.stringify(pods, null, 2));
        else if (pods.length === 0) out('No pods provisioned yet.');
        else out(formatRows(['slug', 'status', 'did'], pods.map((p) => [p.slug, p.status, p.did])));
        return 0;
      }
      default:
        throw new UsageError(`Unknown command: ${positionals.join(' ')}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    const message = e instanceof Error ? e.message : String(e);
    const hint = /relation "platform\./.test(message) ? '\nHint: run `passport platform migrate` first.' : '';
    err(`Error: ${message}${hint}`);
    return 1;
  } finally {
    if (db && io.closeDb !== false) await db.close().catch(() => undefined);
  }
}
