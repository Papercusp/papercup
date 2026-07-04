import { describe, it, expect } from 'vitest';
import {
  generateSeedKey,
  sealBytes,
  openBytes,
  keysEqual,
  SeedCryptoError,
  SEED_KEY_LEN,
} from './index';

describe('seed crypto', () => {
  it('round-trips sealed bytes', () => {
    const key = generateSeedKey();
    const pt = Buffer.from('the private repo bundle bytes');
    const sealed = sealBytes(key, pt);
    expect(sealed.length).toBeGreaterThan(pt.length); // nonce + tag overhead
    expect(openBytes(key, sealed).equals(pt)).toBe(true);
  });

  it('generateSeedKey is 32 bytes', () => {
    expect(generateSeedKey().length).toBe(SEED_KEY_LEN);
  });

  it('two seals of the same plaintext differ (random nonce)', () => {
    const key = generateSeedKey();
    const pt = Buffer.from('same');
    expect(sealBytes(key, pt).equals(sealBytes(key, pt))).toBe(false);
  });

  it('rejects a wrong key', () => {
    const sealed = sealBytes(generateSeedKey(), Buffer.from('x'));
    expect(() => openBytes(generateSeedKey(), sealed)).toThrow(SeedCryptoError);
  });

  it('rejects a tampered blob', () => {
    const key = generateSeedKey();
    const sealed = sealBytes(key, Buffer.from('hello world'));
    sealed[sealed.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => openBytes(key, sealed)).toThrow(/wrong key or tampered/);
  });

  it('rejects a too-short blob', () => {
    expect(() => openBytes(generateSeedKey(), Buffer.from([1, 2, 3]))).toThrow(/too short/);
  });

  it('rejects a wrong-length key', () => {
    expect(() => sealBytes(Buffer.from([1, 2, 3]), Buffer.from('x'))).toThrow(/must be 32 bytes/);
  });

  it('keysEqual compares keys', () => {
    const k = generateSeedKey();
    expect(keysEqual(k, Buffer.from(k))).toBe(true);
    expect(keysEqual(k, generateSeedKey())).toBe(false);
  });
});
