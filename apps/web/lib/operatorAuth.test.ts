import { describe, expect, it } from 'vitest';
import { bearerToken, constantTimeEqual, OperatorAuthError, requireOperator } from './operatorAuth';

const TOKEN = 'op-secret-0123456789';

function req(auth?: string): Request {
  return new Request('https://bioregionalpassport.org/api/control/health', auth ? { headers: { authorization: auth } } : {});
}

describe('constantTimeEqual', () => {
  it('is true only for an exact match', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
  });
  it('rejects a mismatched length instead of short-circuiting', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('bearerToken', () => {
  it('reads the token out of an Authorization: Bearer header', () => {
    expect(bearerToken(req(`Bearer ${TOKEN}`))).toBe(TOKEN);
  });
  it('is null when there is no Authorization header, or it is not Bearer', () => {
    expect(bearerToken(req())).toBeNull();
    expect(bearerToken(req('Basic xyz'))).toBeNull();
  });
});

describe('requireOperator', () => {
  it('passes for the configured operator token', () => {
    expect(() => requireOperator(req(`Bearer ${TOKEN}`), TOKEN)).not.toThrow();
  });
  it('throws 401 UNAUTHENTICATED when the Authorization header is missing', () => {
    try {
      requireOperator(req(), TOKEN);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OperatorAuthError);
      expect((err as OperatorAuthError).status).toBe(401);
      expect((err as OperatorAuthError).code).toBe('UNAUTHENTICATED');
    }
  });
  it('throws 403 OPERATOR_ONLY for a wrong token (constant-time compare fails)', () => {
    try {
      requireOperator(req('Bearer wrong'), TOKEN);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OperatorAuthError);
      expect((err as OperatorAuthError).status).toBe(403);
      expect((err as OperatorAuthError).code).toBe('OPERATOR_ONLY');
    }
  });
  it('fails closed (403) when no OPERATOR_TOKEN is configured, even if a header is sent', () => {
    expect(() => requireOperator(req('Bearer anything'), undefined)).toThrow(OperatorAuthError);
  });
});
