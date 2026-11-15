import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const native = require('sodium-native');
const browser = require('./sodium-browser.cjs');
type Multiply = (out: Uint8Array, scalar: Uint8Array, point: Uint8Array) => unknown;
const hash = (value: string) => createHash('sha256').update(value).digest();
function result(multiply: Multiply, scalar: Uint8Array, point: Uint8Array) {
  const out = Buffer.alloc(32);
  try { multiply(out, scalar, point); return { ok: true, bytes: out.toString('hex') }; }
  catch { return { ok: false }; }
}
function publicKey(seed: Uint8Array) {
  const key = Buffer.alloc(32);
  native.crypto_sign_seed_keypair(key, Buffer.alloc(64), seed);
  return key;
}

describe('browser Ed25519 Noise backend', () => {
  it.each(Array.from({ length: 16 }, (_, i) => i))('matches native libsodium for scalar and key vector %s', index => {
    const scalar = hash(`scalar-${index}`);
    const point = publicKey(hash(`point-${index}`));
    const expected = result(native.crypto_scalarmult_ed25519_noclamp, scalar, point);
    expect(expected.ok).toBe(true);
    expect(result(browser.crypto_scalarmult_ed25519_noclamp, scalar, point)).toEqual(expected);
  });

  it('matches native refusal for zero scalars, identity, small-order and noncanonical points', () => {
    const scalar = hash('edge-scalar');
    const point = publicKey(hash('edge-point'));
    const one = Buffer.alloc(32); one[0] = 1;
    for (const [n, p] of [[Buffer.alloc(32), point], [scalar, one],
      [scalar, Buffer.alloc(32)], [scalar, Buffer.alloc(32, 255)]] as const) {
      expect(result(native.crypto_scalarmult_ed25519_noclamp, n, p)).toEqual({ ok: false });
      expect(result(browser.crypto_scalarmult_ed25519_noclamp, n, p)).toEqual({ ok: false });
    }
  });

  it('preserves scalar inputs and matches high-bit and group-order boundaries', () => {
    const point = publicKey(hash('boundary-point'));
    const one = Buffer.alloc(32); one[0] = 1;
    const high = Buffer.from(one); high[31] = 128;
    // Little-endian order from the Ed25519 specification.
    const order = Buffer.from('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010', 'hex');
    for (const scalar of [one, high, order, Buffer.alloc(32, 255)]) {
      const before = Buffer.from(scalar);
      expect(result(browser.crypto_scalarmult_ed25519_noclamp, scalar, point))
        .toEqual(result(native.crypto_scalarmult_ed25519_noclamp, scalar, point));
      expect(scalar).toEqual(before);
    }
  });
});
