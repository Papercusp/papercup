/**
 * vitest-summary-exit-code-mismatch.test.ts — EI-18653696921091778 regression guard.
 *
 * Observed live 2026-07-25: a `npm run test:affected` run captured a vitest
 * child that printed
 *   Test Files  2 failed | 3274 passed (3276)
 *        Tests  4 failed | 38073 passed (38077)
 * yet exited 0. `scripts/affected-tests.mjs` gated purely on the exit code, so
 * that workspace would have been counted as PASSED despite its own summary
 * reporting reds — the "silence must never look like green" footgun. Fixed by
 * cross-checking `scripts/lib/vitest-summary.mjs`'s `parseSummaryFailedCounts`
 * against a captured run's exit code and treating a mismatch as a failure.
 *
 * These tests exercise the REAL helper + assert the runner actually wires it in.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSummaryFailedCounts } from '../../../../scripts/lib/vitest-summary.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

describe('parseSummaryFailedCounts (EI-18653696921091778)', () => {
  it('extracts failed test-file and test counts from a real vitest failure summary', () => {
    const out = `
 ❯ lib/foo.test.ts (3 tests | 1 failed) 12ms

 Test Files  2 failed | 3274 passed (3276)
      Tests  4 failed | 38073 passed (38077)
   Start at  21:29:58
   Duration  612.40s
`;
    expect(parseSummaryFailedCounts(out)).toEqual({ testFiles: 2, tests: 4 });
  });

  it('returns null for an all-green summary', () => {
    const out = `
 Test Files  116 passed (116)
      Tests  1372 passed (1372)
   Start at  20:51:40
   Duration  11.20s
`;
    expect(parseSummaryFailedCounts(out)).toBeNull();
  });

  it('returns null on empty/nullish/no-summary input', () => {
    expect(parseSummaryFailedCounts('')).toBeNull();
    expect(parseSummaryFailedCounts(null as unknown as string)).toBeNull();
    expect(parseSummaryFailedCounts(undefined as unknown as string)).toBeNull();
    expect(parseSummaryFailedCounts('some unrelated child process output\n')).toBeNull();
  });

  it('tolerates reporter formatting drift (extra whitespace, no parenthesized total)', () => {
    expect(parseSummaryFailedCounts('   Test Files    1 failed\n')).toEqual({ testFiles: 1, tests: 0 });
    expect(parseSummaryFailedCounts('Tests  7 failed | 10 passed\n')).toEqual({ testFiles: 0, tests: 7 });
  });
});

describe('affected-tests.mjs cross-checks the summary against the exit code (EI-18653696921091778)', () => {
  const source = readFileSync(AFFECTED_TESTS, 'utf8');

  it('imports parseSummaryFailedCounts', () => {
    expect(source).toMatch(/import \{ parseSummaryFailedCounts \} from '\.\/lib\/vitest-summary\.mjs'/);
  });

  it('forces a failure when a captured run exits 0 but the summary reports failures', () => {
    expect(source).toMatch(/if \(r\.status === 0 && captureOutput\(\)\) \{/);
    expect(source).toMatch(/summary\.testFiles > 0 \|\| summary\.tests > 0/);
    // The mismatch path must actually flip r.status so the existing
    // quarantine/failed-count bookkeeping below picks it up — a cross-check
    // that only logs a warning without changing the verdict fixes nothing.
    expect(source).toMatch(/r = \{ \.\.\.r, status: 1 \};/);
  });
});
