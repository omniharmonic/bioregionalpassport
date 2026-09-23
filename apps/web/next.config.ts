import path from 'node:path';
import type { NextConfig } from 'next';
import { securityHeaders } from './lib/securityHeaders';

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
  // CSP + nosniff + referrer policy + no framing on every route; relaxations are documented in lib/securityHeaders.ts.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders({
          isDev: process.env['NODE_ENV'] !== 'production',
          ...(process.env['PLATFORM_DOMAIN'] ? { platformDomain: process.env['PLATFORM_DOMAIN'] } : {}),
          ...(process.env['POD_CUSTOM_DOMAINS'] ? { customDomains: process.env['POD_CUSTOM_DOMAINS'] } : {}),
        }),
      },
    ];
  },
  // Next 16 `next dev` writes AGENTS.md / CLAUDE.md into the app by default; this repo keeps its own.
  agentRules: false,
};

export default nextConfig;
