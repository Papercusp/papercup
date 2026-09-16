import { describe, it, expect } from 'vitest';
import {
  HEX_SHA256_RE,
  isHexSha256,
  sha256Hex,
  contentAddressing,
  canonicalTreeDigest,
  GIT_OBJECT_ID_RE,
} from './content-address.ts';

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

describe('content addressing — canonical tree digest (P-001 content pin)', () => {
  const NUL = String.fromCharCode(0);
  const a = { path: 'pkg/a.json', sha: '1'.repeat(40) };
  const b = { path: 'pkg/b.md', sha: '2'.repeat(40) };
  const c = { path: 'pkg/nested/c.txt', sha: '3'.repeat(64) }; // SHA-256 object ids are legal too

  it('is independent of entry order', async () => {
    expect(await canonicalTreeDigest([a, b, c])).toBe(await canonicalTreeDigest([c, a, b]));
    expect(await canonicalTreeDigest([b, c, a])).toBe(await canonicalTreeDigest([a, b, c]));
  });

  it('equals sha256Hex of the hand-built canonical form: sorted `<path> NUL <sha> LF` records', async () => {
    const canonical = [a, b, c]
      .sort((x, y) => (x.path < y.path ? -1 : 1))
      .map((e) => `${e.path}${NUL}${e.sha}\n`)
      .join('');
    expect(await canonicalTreeDigest([c, b, a])).toBe(await sha256Hex(enc.encode(canonical)));
  });

  it('changes when a path, a sha, or the entry set changes', async () => {
    const base = await canonicalTreeDigest([a, b]);
    expect(await canonicalTreeDigest([a, { ...b, sha: '9'.repeat(40) }])).not.toBe(base);
    expect(await canonicalTreeDigest([a, { ...b, path: 'pkg/B.md' }])).not.toBe(base);
    expect(await canonicalTreeDigest([a])).not.toBe(base);
    expect(await canonicalTreeDigest([a, b, c])).not.toBe(base);
  });

  it('refuses a duplicate path, a malformed sha, and an empty/NUL-bearing path', async () => {
    await expect(canonicalTreeDigest([a, { ...a, sha: '4'.repeat(40) }])).rejects.toThrow(/duplicate path/);
    await expect(canonicalTreeDigest([{ path: 'x', sha: 'nothex' }])).rejects.toThrow(/invalid blob sha/);
    await expect(canonicalTreeDigest([{ path: 'x', sha: 'A'.repeat(40) }])).rejects.toThrow(/invalid blob sha/);
    await expect(canonicalTreeDigest([{ path: '', sha: '1'.repeat(40) }])).rejects.toThrow(/invalid path/);
    await expect(canonicalTreeDigest([{ path: `a${NUL}b`, sha: '1'.repeat(40) }])).rejects.toThrow(/invalid path/);
  });

  it('digests an empty set deterministically (the empty-string SHA-256)', async () => {
    expect(await canonicalTreeDigest([])).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(GIT_OBJECT_ID_RE.test('1'.repeat(40))).toBe(true);
    expect(GIT_OBJECT_ID_RE.test('1'.repeat(41))).toBe(false);
  });
});
