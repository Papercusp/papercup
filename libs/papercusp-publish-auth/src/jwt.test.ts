import { describe, expect, it } from 'vitest';
import {
  mintJwt,
  parseJwt,
  verifyJwt,
  verifyJwtSignature,
  JwtError,
} from './jwt';
import { randomBytes, jti } from './random';

const tenantSecret = () => randomBytes(32);

const baseInput = {
  sub: 'tnt_test12345',
  jti: 'fixed-jti',
  sha256: 'a'.repeat(64),
  aud: 'publish' as const,
};

describe('jwt mint + verify', () => {
  it('round-trips claims via verifyJwt', async () => {
    const k = tenantSecret();
    const tok = await mintJwt(k, baseInput);
    const claims = await verifyJwt(k, tok, { audience: 'publish' });
    expect(claims.sub).toBe(baseInput.sub);
    expect(claims.jti).toBe(baseInput.jti);
    expect(claims.sha256).toBe(baseInput.sha256);
    expect(claims.aud).toBe('publish');
  });

  it('rejects wrong audience', async () => {
    const k = tenantSecret();
    const tok = await mintJwt(k, baseInput);
    await expect(verifyJwt(k, tok, { audience: 'snapshot' })).rejects.toThrow(JwtError);
  });

  it('rejects after expiry', async () => {
    const k = tenantSecret();
    const tok = await mintJwt(k, { ...baseInput, ttlSeconds: 1, now: 1000 * 1000 });
    await expect(
      verifyJwt(k, tok, { audience: 'publish', now: 1002 * 1000 }),
    ).rejects.toThrow('jwt expired');
  });

  it('rejects iat too far in future', async () => {
    const k = tenantSecret();
    const tok = await mintJwt(k, { ...baseInput, now: 5000 * 1000 });
    await expect(
      verifyJwt(k, tok, { audience: 'publish', now: 1000 * 1000, clockSkewSec: 5 }),
    ).rejects.toThrow('iat in the future');
  });

  it('rejects bad signature', async () => {
    const k1 = tenantSecret();
    const k2 = tenantSecret();
    const tok = await mintJwt(k1, baseInput);
    await expect(verifyJwt(k2, tok, { audience: 'publish' })).rejects.toThrow(
      'signature mismatch',
    );
  });

  it('rejects sha256 mismatch when expectedSha256 is set', async () => {
    const k = tenantSecret();
    const tok = await mintJwt(k, baseInput);
    await expect(
      verifyJwt(k, tok, { audience: 'publish', expectedSha256: 'b'.repeat(64) }),
    ).rejects.toThrow('sha256 mismatch');
  });

  it('rejects malformed segments', () => {
    expect(() => parseJwt('not-a-jwt')).toThrow(JwtError);
    expect(() => parseJwt('a.b')).toThrow(JwtError);
  });

  it('verifyJwtSignature is constant-time-safe (true on match)', async () => {
    const k = tenantSecret();
    const tok = await mintJwt(k, { ...baseInput, jti: jti() });
    const parsed = parseJwt(tok);
    expect(await verifyJwtSignature(k, parsed)).toBe(true);
  });
});
