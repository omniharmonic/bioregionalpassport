import { boulderManifest } from '@passport/tenant-config';
import { describe, expect, it } from 'vitest';
import { parseManifestJson } from './manifestValidation';

describe('parseManifestJson', () => {
  it('passes for a valid manifest template', () => {
    const result = parseManifestJson(JSON.stringify(boulderManifest));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.identity.slug).toBe('boulder');
  });

  it('fails with a JSON-syntax error path for broken JSON', () => {
    const result = parseManifestJson('{ not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/^\(json\):/);
    }
  });

  it('fails with a field path for a manifest missing a required section', () => {
    const { theme: _theme, ...withoutTheme } = boulderManifest;
    const result = parseManifestJson(JSON.stringify(withoutTheme));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.startsWith('theme'))).toBe(true);
    }
  });
});
