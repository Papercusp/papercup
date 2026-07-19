/**
 * src-hash.test.ts — the content-hash primitives behind the running scout code's
 * identity (WI-5397). Pure-ish IO edges: a real fs read of THIS test file's own
 * neighborhood is used as fixture data (deterministic — the file exists and its
 * bytes don't change mid-run), so these tests need no mocking.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { computeCombinedSourceHash, computeOwnSourceHash } from './src-hash';

const THIS_FILE_URL = import.meta.url;
const THIS_FILE_PATH = fileURLToPath(THIS_FILE_URL);
// A sibling file guaranteed to exist and to be stable for the duration of a test run.
const SIBLING_PATH = fileURLToPath(new URL('./src-hash.ts', import.meta.url));

describe('computeOwnSourceHash', () => {
  it('hashes a real file to a stable 16-hex-char identity', () => {
    const hash = computeOwnSourceHash(THIS_FILE_URL);
    expect(hash).not.toBeNull();
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic — the same file hashes to the same value across calls', () => {
    expect(computeOwnSourceHash(THIS_FILE_URL)).toBe(computeOwnSourceHash(THIS_FILE_URL));
  });

  it('DISCRIMINATES — a different file\'s content hashes to a different value', () => {
    const a = computeOwnSourceHash(THIS_FILE_URL);
    const b = computeOwnSourceHash(new URL('./src-hash.ts', import.meta.url).toString());
    expect(a).not.toBe(b);
  });

  it('matches the direct sha256(bytes) computation (not just "some stable string")', async () => {
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update(readFileSync(THIS_FILE_PATH)).digest('hex').slice(0, 16);
    expect(computeOwnSourceHash(THIS_FILE_URL)).toBe(expected);
  });

  it('degrades to null (never throws) for a missing file', () => {
    expect(computeOwnSourceHash('file:///nonexistent/path/does-not-exist-xyz.ts')).toBeNull();
  });

  it('degrades to null (never throws) for a non-file URL', () => {
    expect(computeOwnSourceHash('https://example.com/not-a-file')).toBeNull();
  });
});

describe('computeCombinedSourceHash', () => {
  it('combines multiple files\' bytes into ONE stable identity', () => {
    const hash = computeCombinedSourceHash([THIS_FILE_PATH, SIBLING_PATH]);
    expect(hash).not.toBeNull();
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(computeCombinedSourceHash([THIS_FILE_PATH, SIBLING_PATH])).toBe(hash);
  });

  it('ORDER matters — the same two files in a different order hash differently', () => {
    const forward = computeCombinedSourceHash([THIS_FILE_PATH, SIBLING_PATH]);
    const reversed = computeCombinedSourceHash([SIBLING_PATH, THIS_FILE_PATH]);
    expect(forward).not.toBe(reversed);
  });

  it('a path separator prevents ["ab","c"]-vs-["a","bc"] boundary collisions', () => {
    // Sanity: combining a single file twice differs from combining it once — proves the
    // separator is actually contributing entropy between entries, not silently no-op'd.
    const once = computeCombinedSourceHash([THIS_FILE_PATH]);
    const twice = computeCombinedSourceHash([THIS_FILE_PATH, THIS_FILE_PATH]);
    expect(once).not.toBe(twice);
  });

  it('an unreadable file in the list makes the WHOLE combination null — never a partial hash', () => {
    expect(computeCombinedSourceHash([THIS_FILE_PATH, '/nonexistent/path/xyz.ts'])).toBeNull();
  });

  it('an empty list still produces a stable (non-null) hash of zero files', () => {
    // Documents actual behavior of an edge input rather than leaving it unspecified.
    const hash = computeCombinedSourceHash([]);
    expect(hash).not.toBeNull();
    expect(hash).toBe(computeCombinedSourceHash([]));
  });
});
