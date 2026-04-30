import { describe, expect, it } from 'vitest';
import { manifestSha256Hex, normalizeManifest } from './manifest-hash';

describe('manifest sha256', () => {
  const a = {
    deployment_slug: 'sheets',
    files: [
      { path: 'b.html', sha256: 'b'.repeat(64), bytes: 2 },
      { path: 'a.html', sha256: 'a'.repeat(64), bytes: 1 },
    ],
  };
  const b = {
    deployment_slug: 'sheets',
    files: [
      { path: 'a.html', sha256: 'a'.repeat(64), bytes: 1 },
      { path: 'b.html', sha256: 'b'.repeat(64), bytes: 2 },
    ],
  };

  it('produces the same hash regardless of file order', async () => {
    const ha = await manifestSha256Hex(a);
    const hb = await manifestSha256Hex(b);
    expect(ha).toBe(hb);
  });

  it('NFC-normalizes paths so macOS NFD == Linux NFC', async () => {
    const nfd = {
      deployment_slug: 's',
      files: [{ path: 'café.html', sha256: 'a'.repeat(64), bytes: 1 }],
    };
    const nfc = {
      deployment_slug: 's',
      files: [{ path: 'café.html', sha256: 'a'.repeat(64), bytes: 1 }],
    };
    expect(await manifestSha256Hex(nfd)).toBe(await manifestSha256Hex(nfc));
  });

  it('hash differs when content sha256 changes', async () => {
    const c = structuredClone(a);
    c.files[0].sha256 = 'c'.repeat(64);
    expect(await manifestSha256Hex(a)).not.toBe(await manifestSha256Hex(c));
  });

  it('hash differs when deployment_slug changes', async () => {
    const c = { ...a, deployment_slug: 'other' };
    expect(await manifestSha256Hex(a)).not.toBe(await manifestSha256Hex(c));
  });

  it('normalizeManifest sorts files by path', () => {
    const n = normalizeManifest(a);
    expect(n.files.map((f) => f.path)).toEqual(['a.html', 'b.html']);
  });

  it('sha256 is 64 hex chars', async () => {
    const h = await manifestSha256Hex(a);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
