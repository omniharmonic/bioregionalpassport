import { describe, expect, it } from 'vitest';
import { createSession, readSession, type VerifyResult } from './index.js';

const result: VerifyResult = {
  ok: true,
  subject: 'did:key:z6MkAlice',
  pod: 'did:web:bioregionalpassport.org:dids:boulder',
  tier: 'T1',
  authorities: ['event:attend', 'round:comment'],
  delegatedFor: 'did:web:bioregionalpassport.org:dids:garden-collective',
  explanation: [],
};
const SECRET = 'test-secret-please-rotate-0123456789abcdef'; // ≥ 32 bytes

describe('sessions', () => {
  it('round-trips claims through an HS256 compact token', async () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const token = await createSession(result, SECRET, 3600, now);
    expect(token.split('.')).toHaveLength(3);
    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    const claims = await readSession(token, SECRET, new Date('2026-10-01T00:30:00Z'));
    expect(claims).toEqual({
      subject: result.subject,
      pod: result.pod,
      tier: 'T1',
      authorities: result.authorities,
      delegatedFor: result.delegatedFor,
      iat: now.getTime() / 1000,
      exp: now.getTime() / 1000 + 3600,
    });
  });

  it('returns null for a tampered token', async () => {
    const token = await createSession(result, SECRET);
    const [h, p, s] = token.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    payload.authorities.push('vmc:grant');
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    expect(await readSession(forged, SECRET)).toBeNull();
    expect(await readSession(`${h}.${p}.${s.slice(0, -2)}AA`, SECRET)).toBeNull();
    expect(await readSession(token, 'another-secret-also-long-enough-0123456789')).toBeNull();
    expect(await readSession('not-a-token', SECRET)).toBeNull();
  });

  it('returns null once expired', async () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const token = await createSession(result, SECRET, 60, now);
    expect(await readSession(token, SECRET, new Date('2026-10-01T00:00:59Z'))).not.toBeNull();
    expect(await readSession(token, SECRET, new Date('2026-10-01T00:01:00Z'))).toBeNull();
  });

  it('requires a secret of at least 32 bytes', async () => {
    await expect(createSession(result, 'short-secret')).rejects.toThrow(/32 bytes/);
    const token = await createSession(result, SECRET);
    await expect(readSession(token, 'short-secret')).rejects.toThrow(/32 bytes/);
  });

  it('returns null when iat/exp are not integers, even with a valid HMAC', async () => {
    const { createHmac } = await import('node:crypto');
    const forge = (payload: object) => {
      const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
    };
    const base = { sub: 'did:key:z6MkAlice', authorities: [] };
    expect(await readSession(forge({ ...base, iat: 1, exp: 4102444800 }), SECRET)).not.toBeNull();
    expect(await readSession(forge({ ...base, iat: '1', exp: 4102444800 }), SECRET)).toBeNull();
    expect(await readSession(forge({ ...base, iat: 1, exp: 'never' }), SECRET)).toBeNull();
    expect(await readSession(forge({ ...base, exp: 4102444800 }), SECRET)).toBeNull();
  });

  it('refuses to open a session for a failed verification', async () => {
    await expect(createSession({ ...result, ok: false }, SECRET)).rejects.toThrow();
  });
});
