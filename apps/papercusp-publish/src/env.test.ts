/**
 * env.test.ts — publish-worker key derivation accessors.
 *
 * env.ts is mostly the Env binding interface (pure types, untestable). The two
 * runtime functions, jwtKey() / hashPepper(), pull the right secret field off
 * the env and base64url-decode it. The decode itself is covered in
 * @papercusp/publish-auth; this pins the GLUE — that each accessor reads its
 * OWN field (JWT_SECRET vs HASH_PEPPER, never crossed) and returns the decoded
 * bytes verbatim. The decoder is mocked so a swapped field is detectable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  b64uDecode: vi.fn((s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)))),
}));

vi.mock('@papercusp/publish-auth', () => ({ b64uDecode: h.b64uDecode }));

import { jwtKey, hashPepper } from './env.ts';

// Minimal env stub: only the two secret fields these accessors read.
const mkEnv = (jwt: string, pepper: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ({ JWT_SECRET: jwt, HASH_PEPPER: pepper } as any);

afterEach(() => vi.clearAllMocks());

describe('jwtKey', () => {
  it('decodes the JWT_SECRET field (not HASH_PEPPER)', () => {
    const out = jwtKey(mkEnv('jwt-secret-val', 'pepper-val'));
    expect(h.b64uDecode).toHaveBeenCalledTimes(1);
    expect(h.b64uDecode).toHaveBeenCalledWith('jwt-secret-val');
    expect(out).toBeInstanceOf(Uint8Array);
    expect([...out]).toEqual([...'jwt-secret-val'].map((c) => c.charCodeAt(0)));
  });
});

describe('hashPepper', () => {
  it('decodes the HASH_PEPPER field (not JWT_SECRET)', () => {
    const out = hashPepper(mkEnv('jwt-secret-val', 'pepper-val'));
    expect(h.b64uDecode).toHaveBeenCalledTimes(1);
    expect(h.b64uDecode).toHaveBeenCalledWith('pepper-val');
    expect([...out]).toEqual([...'pepper-val'].map((c) => c.charCodeAt(0)));
  });

  it('returns the decoder output verbatim (no transformation)', () => {
    const sentinel = new Uint8Array([9, 8, 7]);
    h.b64uDecode.mockReturnValueOnce(sentinel);
    expect(hashPepper(mkEnv('x', 'y'))).toBe(sentinel);
  });
});
