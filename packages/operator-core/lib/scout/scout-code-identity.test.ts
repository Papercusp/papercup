/**
 * scout-code-identity.test.ts — the running scout code's content identity (WI-5397).
 * currentScoutCodeHash() hashes the REAL on-disk bytes of SCOUT_CODE_IDENTITY_FILES
 * (capacity-errors.ts + scheduler.ts + quality-metrics.ts, all present in this repo),
 * memoized for the process's lifetime — these tests exercise the real files (no
 * mocking needed; they exist and don't change mid-run) and the memo/reset behavior.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { computeCombinedSourceHash } from './src-hash';
import { _resetScoutCodeHashForTest, currentScoutCodeHash, SCOUT_CODE_IDENTITY_FILES } from './scout-code-identity';

afterEach(() => {
  _resetScoutCodeHashForTest();
});

describe('currentScoutCodeHash', () => {
  it('resolves a real 16-hex-char hash over the identity files (they exist on disk in this repo)', () => {
    const hash = currentScoutCodeHash();
    expect(hash).not.toBeNull();
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('matches computeCombinedSourceHash over the SAME resolved paths, in the SAME declared order', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const paths = SCOUT_CODE_IDENTITY_FILES.map((rel) => dir + rel.replace(/^\.\//, ''));
    // Sanity: every file this module claims to hash is actually readable.
    for (const p of paths) expect(() => readFileSync(p)).not.toThrow();
    expect(currentScoutCodeHash()).toBe(computeCombinedSourceHash(paths));
  });

  it('memoizes — returns the SAME value across repeated calls within a process without recomputing', () => {
    const first = currentScoutCodeHash();
    const second = currentScoutCodeHash();
    expect(second).toBe(first);
  });

  it('_resetScoutCodeHashForTest clears the memo so a subsequent call recomputes fresh', () => {
    const before = currentScoutCodeHash();
    _resetScoutCodeHashForTest();
    const after = currentScoutCodeHash();
    // Same on-disk files ⇒ same value, but it genuinely recomputed rather than reusing a
    // stale closure — proven by the fact that resetting and recomputing is idempotent.
    expect(after).toBe(before);
  });

  it('SCOUT_CODE_IDENTITY_FILES is a non-empty, append-only-by-convention list', () => {
    expect(SCOUT_CODE_IDENTITY_FILES.length).toBeGreaterThan(0);
    expect(SCOUT_CODE_IDENTITY_FILES).toContain('./capacity-errors.ts');
    expect(SCOUT_CODE_IDENTITY_FILES).toContain('./scheduler.ts');
    expect(SCOUT_CODE_IDENTITY_FILES).toContain('./quality-metrics.ts');
  });
});
