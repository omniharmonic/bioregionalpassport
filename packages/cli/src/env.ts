import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Minimal `.env` parser: `KEY=value`, optional `export `, quotes, `#` comments. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1] as string;
    let value = (m[2] ?? '').trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.lastIndexOf(q) > 0) {
      value = value.slice(1, value.lastIndexOf(q));
      if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Walks up from `start` to the directory holding `pnpm-workspace.yaml`. */
export function findRepoRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Loads `<repo root>/.env` into `env` without overriding variables already set.
 * The root is searched from `cwd`, then from this file's location. Returns the file loaded, if any.
 */
export function loadDotEnv(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string | undefined {
  const roots = [findRepoRoot(cwd), findRepoRoot(dirname(fileURLToPath(import.meta.url)))];
  for (const root of roots) {
    if (!root) continue;
    const file = join(root, '.env');
    if (!existsSync(file)) continue;
    for (const [k, v] of Object.entries(parseDotEnv(readFileSync(file, 'utf8')))) {
      if (env[k] === undefined) env[k] = v;
    }
    return file;
  }
  return undefined;
}
