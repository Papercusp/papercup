/**
 * Coverage for the dev-watch dist chunk-prune logic (Option-1 build-churn cure;
 * plan `adv-build-churn-retain-chunks-2026-06-03`).
 *
 * The plugin runs `vite build --watch` with `emptyOutDir:false`, so old hashed
 * chunks are RETAINED across rebuilds (a long-open webview keeps resolving the
 * build it loaded instead of 404-ing). The tradeoff is that `dist/assets/`
 * grows unbounded; `selectStaleChunks()` decides which files are old enough to
 * delete. It is pure (no disk) so the age policy is testable in isolation.
 *
 * Policy: a file is stale iff it was last modified strictly MORE than `ttlMs`
 * ago. Freshly-written files (the current build) always survive; a file exactly
 * at the boundary is kept (conservative — never over-prune).
 */
import { describe, expect, it } from 'vitest';
import { resolveTtlMs, selectStaleChunks, shouldRetainDistChunks } from './dev-dist-prune';

const NOW = 1_000_000_000_000; // fixed clock so the tests are deterministic
const MIN = 60_000;

describe('selectStaleChunks', () => {
  it('returns nothing for an empty dist', () => {
    expect(selectStaleChunks([], NOW, 60 * MIN)).toEqual([]);
  });

  it('keeps every file newer than the TTL', () => {
    const files = [
      { name: 'assets/index-aaa.js', mtimeMs: NOW - 1 * MIN },
      { name: 'assets/vditor-bbb.js', mtimeMs: NOW - 30 * MIN },
    ];
    expect(selectStaleChunks(files, NOW, 60 * MIN)).toEqual([]);
  });

  it('returns only the files older than the TTL', () => {
    const files = [
      { name: 'assets/index-fresh.js', mtimeMs: NOW - 5 * MIN }, // keep
      { name: 'assets/vditor-stale.js', mtimeMs: NOW - 90 * MIN }, // prune
      { name: 'assets/old-route-stale.js', mtimeMs: NOW - 61 * MIN }, // prune
    ];
    expect(selectStaleChunks(files, NOW, 60 * MIN)).toEqual([
      'assets/vditor-stale.js',
      'assets/old-route-stale.js',
    ]);
  });

  it('keeps a file sitting exactly on the TTL boundary (no over-prune)', () => {
    const files = [{ name: 'assets/edge.js', mtimeMs: NOW - 60 * MIN }];
    expect(selectStaleChunks(files, NOW, 60 * MIN)).toEqual([]);
  });
});

describe('resolveTtlMs', () => {
  it('defaults to 60 minutes when the env var is unset', () => {
    expect(resolveTtlMs({})).toBe(60 * MIN);
  });

  it('honors a valid PAPERCUSP_DIST_CHUNK_TTL_MIN override', () => {
    expect(resolveTtlMs({ PAPERCUSP_DIST_CHUNK_TTL_MIN: '15' })).toBe(15 * MIN);
  });

  it('falls back to the default for a non-numeric or non-positive value (no footgun)', () => {
    expect(resolveTtlMs({ PAPERCUSP_DIST_CHUNK_TTL_MIN: 'nonsense' })).toBe(60 * MIN);
    expect(resolveTtlMs({ PAPERCUSP_DIST_CHUNK_TTL_MIN: '0' })).toBe(60 * MIN);
    expect(resolveTtlMs({ PAPERCUSP_DIST_CHUNK_TTL_MIN: '-5' })).toBe(60 * MIN);
  });
});

// Retention is the DEFAULT (plan `dist-chunk-retention-default-2026-07-26`, D-001).
// It used to be opt-IN via `=1`, and for weeks NOTHING in the repo set that flag —
// the cure shipped switched-off while the stale-chunk 404 kept firing. These tests
// pin the inversion so it cannot silently regress to an opt-in again.
describe('shouldRetainDistChunks', () => {
  it('retains for a `vite build --watch`', () => {
    expect(shouldRetainDistChunks(['node', 'vite', 'build', '--watch'], {})).toBe(true);
  });

  it('retains for a plain one-shot build — the default, no env needed', () => {
    expect(shouldRetainDistChunks(['node', 'vite', 'build'], {})).toBe(true);
  });

  it('empties ONLY for an explicit PAPERCUSP_RETAIN_DIST_CHUNKS=0 opt-out', () => {
    expect(shouldRetainDistChunks(['node', 'vite', 'build'], { PAPERCUSP_RETAIN_DIST_CHUNKS: '0' })).toBe(false);
  });

  it('treats any value other than the exact "0" opt-out as retain (fail safe)', () => {
    // A typo'd/blank/legacy value must never silently disable retention — the
    // failure mode of the old opt-in was precisely "the flag was never right".
    for (const v of ['1', 'true', 'false', '', 'no', 'off']) {
      expect(shouldRetainDistChunks(['node', 'vite', 'build'], { PAPERCUSP_RETAIN_DIST_CHUNKS: v })).toBe(true);
    }
  });

  it('never lets a --watch build opt out — emptying under a live watcher is the original bug', () => {
    expect(
      shouldRetainDistChunks(['node', 'vite', 'build', '--watch'], { PAPERCUSP_RETAIN_DIST_CHUNKS: '0' }),
    ).toBe(true);
  });
});
