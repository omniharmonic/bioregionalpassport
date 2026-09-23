import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship compiled ESM in `dist`, so they need no transpiling.
  // Database drivers stay out of the server bundle and load with Node's own resolver.
  serverExternalPackages: ['postgres', '@electric-sql/pglite'],
  turbopack: {
    rules: {
      // `@passport/db` finds its SQL migrations relative to its own module URL; rewrite
      // that to a runtime lookup (see build/db-migrations-loader.cjs).
      'migrate.js': {
        condition: { content: /new URL\(\s*['"]\.\.\/migrations\// },
        loaders: [path.resolve(process.cwd(), 'build/db-migrations-loader.cjs')],
        as: '*.js',
      },
    },
  },
  // Ship the migration SQL with every server function (health, control plane).
  outputFileTracingIncludes: {
    '/**': ['../../packages/db/migrations/**/*.sql'],
  },
  // Trace files from the monorepo root so workspace packages are included.
  outputFileTracingRoot: path.resolve(process.cwd(), '../..'),
  poweredByHeader: false,
};

export default nextConfig;
