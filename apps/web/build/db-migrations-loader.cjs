/**
 * Turbopack loader for `@passport/db`'s `dist/migrate.js`.
 *
 * `@passport/db` locates its SQL migrations with
 * `new URL('../migrations/<kind>/', import.meta.url)`. Bundlers treat that as a
 * static asset reference (a directory, which fails to resolve), and inside a
 * bundle `import.meta.url` no longer points at the package anyway. This loader
 * rewrites those two expressions to a runtime lookup of the migrations
 * directory; the SQL files themselves ship via `outputFileTracingIncludes`.
 */
const PRELUDE = `
import { existsSync as __bpExists } from 'node:fs';
import { join as __bpJoin } from 'node:path';
import { pathToFileURL as __bpToUrl } from 'node:url';
function __bpMigrationsUrl(kind) {
  const cwd = process.cwd();
  const candidates = [
    process.env.PASSPORT_DB_MIGRATIONS_DIR,
    __bpJoin(cwd, '../../packages/db/migrations'),
    __bpJoin(cwd, 'packages/db/migrations'),
    __bpJoin(cwd, 'node_modules/@passport/db/migrations'),
    '/var/task/packages/db/migrations',
  ].filter(Boolean);
  const root = candidates.find((dir) => __bpExists(__bpJoin(dir, kind))) ?? candidates[0];
  return __bpToUrl(__bpJoin(root, kind) + '/');
}
`;

module.exports = function dbMigrationsLoader(source) {
  const pattern = /new URL\(\s*['"]\.\.\/migrations\/(platform|pod)\/['"]\s*,\s*import\.meta\.url\s*\)/g;
  if (!pattern.test(source)) return source;
  pattern.lastIndex = 0;
  return PRELUDE + source.replace(pattern, (_m, kind) => `__bpMigrationsUrl('${kind}')`);
};
