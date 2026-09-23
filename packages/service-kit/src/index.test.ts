import { describe, expect, it } from 'vitest';
import { ServiceError, errorResult, requireAuthority, requireSession } from './index.js';

const session = { subject: 'did:key:z1', pod: 'did:web:x', authorities: ['pep:review'] };

describe('service-kit', () => {
  it('requireSession throws 401 without a session', () => {
    expect(() => requireSession({ params: {}, query: {}, body: null })).toThrowError(ServiceError);
    try {
      requireSession({ params: {}, query: {}, body: null });
    } catch (e) {
      expect((e as ServiceError).status).toBe(401);
      expect((e as ServiceError).code).toBe('UNAUTHENTICATED');
    }
    expect(requireSession({ params: {}, query: {}, body: null, session })).toBe(session);
  });

  it('requireAuthority checks the scope with or without prefix', () => {
    const req = { params: {}, query: {}, body: null, session };
    expect(requireAuthority(req, 'pep:review')).toBe(session);
    expect(requireAuthority(req, 'authority:pep:review')).toBe(session);
    try {
      requireAuthority(req, 'vwc:issue');
      expect.unreachable();
    } catch (e) {
      expect((e as ServiceError).status).toBe(403);
      expect((e as ServiceError).code).toBe('MISSING_AUTHORITY');
      expect((e as ServiceError).message).toMatch(/vwc:issue/);
    }
  });

  it('errorResult maps errors to JSON bodies', () => {
    expect(errorResult(new ServiceError(400, 'BAD', 'Bad.', 'Try again.'))).toEqual({
      status: 400,
      body: { code: 'BAD', message: 'Bad.', hint: 'Try again.' },
    });
    expect(errorResult(new Error('x')).status).toBe(500);
  });
});
