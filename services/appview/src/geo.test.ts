import { describe, expect, it } from 'vitest';
import { parseBbox } from './geo.js';
import { ServiceError } from './kit.js';

function expectInvalidBbox(raw: string): void {
  let caught: unknown;
  try {
    parseBbox(raw);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ServiceError);
  expect((caught as ServiceError).status).toBe(400);
  expect((caught as ServiceError).code).toBe('INVALID_BBOX');
}

describe('parseBbox', () => {
  it('returns undefined when bbox is absent, so callers fall back to manifest bounds', () => {
    expect(parseBbox(undefined)).toBeUndefined();
  });

  it('parses a valid bbox', () => {
    expect(parseBbox('-105.7,39.9,-105.1,40.2')).toEqual({
      minLon: -105.7,
      minLat: 39.9,
      maxLon: -105.1,
      maxLat: 40.2,
    });
  });

  it('throws INVALID_BBOX for the wrong number of parts', () => {
    expectInvalidBbox('1,2,3');
    expectInvalidBbox('1,2,3,4,5');
  });

  it('throws INVALID_BBOX for non-numeric parts', () => {
    expectInvalidBbox('a,b,c,d');
  });

  it('throws INVALID_BBOX for an inverted or degenerate bbox', () => {
    expectInvalidBbox('-105.1,40.2,-105.7,39.9'); // min/max swapped
    expectInvalidBbox('-105.1,39.9,-105.1,40.2'); // minLon == maxLon
  });
});
