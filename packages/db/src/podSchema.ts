const SLUG_RE = /^[a-z0-9-]{2,40}$/;

/**
 * Validates a pod slug and maps it to its Postgres schema name.
 * `boulder` -> `pod_boulder`, `tenant-zero` -> `pod_tenant_zero`.
 */
export function podSchema(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new Error('invalid pod slug');
  }
  return 'pod_' + slug.replaceAll('-', '_');
}
