/**
 * The manifest/trust-policy editors' validation helper: JSON.parse + the
 * tenant-config validators, with a JSON syntax error reported the same way as
 * a schema error (a one-line message in the `errors` array) so the editor can
 * show one error list regardless of what went wrong.
 */
import {
  validateManifest,
  validateTrustPolicy,
  type BioregionManifest,
  type TrustPolicy,
} from '@passport/tenant-config';

export type ManifestParseResult = { ok: true; manifest: BioregionManifest } | { ok: false; errors: string[] };
export type TrustPolicyParseResult = { ok: true; policy: TrustPolicy } | { ok: false; errors: string[] };

function parseJson(text: string): { ok: true; data: unknown } | { ok: false; errors: string[] } {
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (err) {
    return { ok: false, errors: [`(json): ${err instanceof Error ? err.message : 'the text is not valid JSON'}`] };
  }
}

/** Parses manifest JSON text and validates it against `ManifestSchema`. Errors carry a `path: message` per issue. */
export function parseManifestJson(text: string): ManifestParseResult {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  return validateManifest(parsed.data);
}

/** Parses trust-policy JSON text and validates it against `TrustPolicySchema`. */
export function parseTrustPolicyJson(text: string): TrustPolicyParseResult {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  return validateTrustPolicy(parsed.data);
}
