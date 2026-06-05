import { describe, it, expect } from 'vitest';
import { HEX_SHA256_RE, isHexSha256, sha256Hex, contentAddressing } from './content-address.ts';

const enc = new TextEncoder();

describe('content addressing — hashing', () => {
  it('sha256Hex matches known vectors (empty + "abc")', async () => {
    expect(await sha256Hex(enc.encode(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex(enc.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes an ArrayBuffer and a Uint8Array view identically', async () => {
    const u8 = enc.encode('papercusp');
    expect(await sha256Hex(u8)).toBe(await sha256Hex(u8.buffer as ArrayBuffer));
  });

  it('isHexSha256 / HEX_SHA256_RE accept only 64 lowercase-hex chars', () => {
    const good = 'a'.repeat(64);
    expect(isHexSha256(good)).toBe(true);
    expect(HEX_SHA256_RE.test(good)).toBe(true);
    expect(isHexSha256('A'.repeat(64))).toBe(false); // uppercase
    expect(isHexSha256('a'.repeat(63))).toBe(false); // too short
    expect(isHexSha256('a'.repeat(65))).toBe(false); // too long
    expect(isHexSha256('g'.repeat(64))).toBe(false); // non-hex
    expect(isHexSha256(123)).toBe(false);
    expect(isHexSha256(null)).toBe(false);
  });
});

describe('content addressing — scheme', () => {
  const sha = 'b'.repeat(64);

  it('builds <prefix>/<hash><ext> keys and matches them', () => {
    const s = contentAddressing({ prefix: 'snapshots', ext: '.tar.gz' });
    expect(s.key(sha)).toBe(`snapshots/${sha}.tar.gz`);
    expect(s.matches(`snapshots/${sha}.tar.gz`, sha)).toBe(true);
    expect(s.matches(`snapshots/deadbeef.tar.gz`, sha)).toBe(false);
    expect(s.matches(`other/${sha}.tar.gz`, sha)).toBe(false);
  });

  it('parses a hash back out of a key, and rejects foreign keys', () => {
    const s = contentAddressing({ prefix: 'snapshots', ext: '.tar.gz' });
    expect(s.parse(`snapshots/${sha}.tar.gz`)).toBe(sha);
    expect(s.parse(`snapshots/not-a-hash.tar.gz`)).toBe(null);
    expect(s.parse(`snapshots/${sha}.zip`)).toBe(null); // wrong ext
    expect(s.parse(`plugins/${sha}.tar.gz`)).toBe(null); // wrong prefix
  });

  it('supports an empty extension and trims a trailing slash on the prefix', () => {
    const s = contentAddressing({ prefix: 'blobs/' });
    expect(s.key(sha)).toBe(`blobs/${sha}`);
    expect(s.parse(`blobs/${sha}`)).toBe(sha);
  });
});
