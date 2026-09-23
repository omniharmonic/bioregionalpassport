/**
 * Validated server environment. Read lazily (on first use) so `next build`
 * never needs secrets; a missing required variable fails the first request
 * that needs it with a clear message instead of crashing the build.
 */
import 'server-only';

export const DEFAULT_PLATFORM_DOMAIN = 'bioregionalpassport.org';

export interface ServerEnv {
  DATABASE_URL: string;
  POD_KEY_ENCRYPTION_KEY: string;
  SESSION_SECRET: string;
  PLATFORM_DOMAIN: string;
  /** Break-glass bearer token for the first pod operator; unset disables it. */
  OPERATOR_TOKEN: string | undefined;
  /** `domain=slug,…` static custom-domain map. */
  POD_CUSTOM_DOMAINS: Record<string, string>;
  isProduction: boolean;
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

/** Parses `POD_CUSTOM_DOMAINS` (`commons.example.org=boulder,tz.example.org=tenant-zero`). */
export function parseCustomDomains(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const [domain, slug] = pair.split('=').map((s) => s.trim().toLowerCase());
    if (domain && slug && /^[a-z0-9-]{2,40}$/.test(slug)) out[domain] = slug;
  }
  return out;
}

export function readEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const errors: string[] = [];
  const required = (name: string): string => {
    const v = source[name]?.trim();
    if (!v) errors.push(`${name} is not set.`);
    return v ?? '';
  };
  const env: ServerEnv = {
    DATABASE_URL: required('DATABASE_URL'),
    POD_KEY_ENCRYPTION_KEY: required('POD_KEY_ENCRYPTION_KEY'),
    SESSION_SECRET: required('SESSION_SECRET'),
    PLATFORM_DOMAIN: (source['PLATFORM_DOMAIN']?.trim() || DEFAULT_PLATFORM_DOMAIN).toLowerCase(),
    OPERATOR_TOKEN: source['OPERATOR_TOKEN']?.trim() || undefined,
    POD_CUSTOM_DOMAINS: parseCustomDomains(source['POD_CUSTOM_DOMAINS']),
    isProduction: source['NODE_ENV'] === 'production',
  };
  if (env.POD_KEY_ENCRYPTION_KEY && !/^[0-9a-fA-F]{64}$/.test(env.POD_KEY_ENCRYPTION_KEY)) {
    errors.push('POD_KEY_ENCRYPTION_KEY must be 64 hex characters.');
  }
  if (env.SESSION_SECRET && new TextEncoder().encode(env.SESSION_SECRET).length < 32) {
    errors.push('SESSION_SECRET must be at least 32 bytes.');
  }
  if (errors.length > 0) throw new EnvError(`Server environment is incomplete: ${errors.join(' ')}`);
  return env;
}

let cached: ServerEnv | undefined;

/** The validated environment, cached after the first successful read. */
export function env(): ServerEnv {
  cached ??= readEnv();
  return cached;
}

/** Platform domain without requiring the rest of the environment (safe for pages that only render links). */
export function platformDomain(): string {
  return (process.env['PLATFORM_DOMAIN']?.trim() || DEFAULT_PLATFORM_DOMAIN).toLowerCase();
}
