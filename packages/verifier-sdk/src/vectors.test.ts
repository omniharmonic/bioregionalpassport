import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createResolver } from '@passport/credential-core';
import { verifyDTG } from './index.js';
import { buildVectors, type ConformanceVector } from '../scripts/gen-vectors.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'vectors');
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const vectors: ConformanceVector[] = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));

describe('B3 §10 conformance vectors', () => {
  it('contains exactly the eight B3 §10 cases', () => {
    expect(vectors.map((v) => v.name).sort()).toEqual(
      ['ack-digest-mismatch', 'broadened-attenuation', 'expired-vac', 'grant-without-ack', 'pod-mismatch', 'unknown-predicate', 'valid-pair', 'vdc-chain-exceeding-depth'],
    );
  });

  it('are reproducible: regenerating yields the committed files', () => {
    const fresh = JSON.parse(JSON.stringify(buildVectors())) as ConformanceVector[];
    for (const v of fresh) expect(vectors.find((x) => x.name === v.name)).toEqual(v);
  });

  for (const v of vectors) {
    it(`${v.name}: ${v.expected.ok ? 'accepted' : v.expected.errorCode}`, async () => {
      const r = await verifyDTG(v.presentation, v.policy, {
        resolver: createResolver({ staticDocs: v.staticDids }),
        now: () => new Date(v.now),
      });
      expect(r.ok).toBe(v.expected.ok);
      expect(r.error?.code).toBe(v.expected.errorCode);
      if (v.expected.authorities) expect(r.authorities).toEqual(v.expected.authorities);
      expect(r.explanation.length).toBeGreaterThan(0);
      if (r.error) {
        // one plain sentence
        expect(r.error.message).toMatch(/^[A-Z].*[.]$/);
        expect(r.explanation).toContain(r.error.message);
      }
    });
  }
});
