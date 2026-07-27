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

// @ts-expect-error vitest-summary.mjs is a standalone Node script without declarations.
import { parseSummaryFailedCounts, parseFailedTestFiles } from '../../../../scripts/lib/vitest-summary.mjs';

/**
 * EI-18819483316574031 — VERBATIM bytes from the gate run that advanced the green pin
 * over a real, deterministic failure (candidate e1e2dfdbbcda, 2026-07-27T17:17Z,
 * ~/.papercusp/checkpoint-logs/2026-07-27T17-17-31-003Z-...-cand-e1e2dfdbbcda.log
 * lines 273/274 and the operator-vite rollup row).
 *
 * These are NOT hand-written approximations of "what vitest probably prints" — that is
 * precisely the mistake that let this bug live: every pre-existing case above uses clean,
 * uncoloured text, so the parser looked correct while being blind on real gate output.
 */
const REAL_ANSI_SUMMARY =
  '[2m Test Files [22m [1m[31m1 failed[39m[22m[2m | [22m[1m[32m161 passed[39m[22m[90m (162)[39m\n' +
  '[2m      Tests [22m [1m[31m1 failed[39m[22m[2m | [22m[1m[32m1598 passed[39m[22m[90m (1599)[39m\n';

const REAL_ANSI_ROLLUP =
  ' [31m❯[39m src/components/adv/learning-empty-state-copy.guard.test.ts [2m([22m[2m5 tests[22m[2m | [22m[31m1 failed[39m[2m)[22m[32m 15[2mms[22m[39m\n';

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

  // ── EI-18819483316574031: the ANSI blindness that disabled this guard in production ──
  it('parses a COLOURISED summary — the real gate output shape', () => {
    expect(parseSummaryFailedCounts(REAL_ANSI_SUMMARY)).toEqual({ testFiles: 1, tests: 1 });
  });

  it('still returns null for a colourised ALL-GREEN summary (no false positives)', () => {
    const green =
      '[2m Test Files [22m [1m[32m162 passed[39m[22m[90m (162)[39m\n' +
      '[2m      Tests [22m [1m[32m1599 passed[39m[22m[90m (1599)[39m\n';
    expect(parseSummaryFailedCounts(green)).toBeNull();
  });
});

describe('parseFailedTestFiles (EI-18819483316574031)', () => {
  it('extracts the failing file from a COLOURISED rollup row', () => {
    expect(parseFailedTestFiles(REAL_ANSI_ROLLUP)).toEqual([
      'src/components/adv/learning-empty-state-copy.guard.test.ts',
    ]);
  });

  it('extracts the failing file from a COLOURISED bare FAIL row', () => {
    const failRow = ' [41m[1m FAIL [22m[49m [36msrc/components/adv/x.test.ts[39m\n';
    expect(parseFailedTestFiles(failRow)).toEqual(['src/components/adv/x.test.ts']);
  });

  it('still parses uncoloured output, and ignores passing rollups', () => {
    const out = [
      ' ❯ lib/foo.test.ts (3 tests | 1 failed) 12ms',
      ' ✓ lib/bar.test.ts (7 tests) 9ms',
      'FAIL  lib/baz.test.ts',
      '',
    ].join('\n');
    expect(parseFailedTestFiles(out).sort()).toEqual(['lib/baz.test.ts', 'lib/foo.test.ts']);
  });

  it('returns [] on empty/nullish input', () => {
    expect(parseFailedTestFiles('')).toEqual([]);
    expect(parseFailedTestFiles(null as unknown as string)).toEqual([]);
  });
});

describe('affected-tests.mjs cross-checks the summary against the exit code (EI-18653696921091778)', () => {
  const source = readFileSync(AFFECTED_TESTS, 'utf8');

  it('imports parseSummaryFailedCounts from the shared parser module', () => {
    expect(source).toMatch(/import \{[^}]*\bparseSummaryFailedCounts\b[^}]*\} from '\.\/lib\/vitest-summary\.mjs'/);
  });

  // EI-18819483316574031: the failed-file parser must be the SHARED one, not a local
  // re-implementation — a second copy is what drifted out of ANSI-sync last time.
  it('uses the shared parseFailedTestFiles rather than a local regex copy', () => {
    expect(source).toMatch(/import \{[^}]*\bparseFailedTestFiles\b[^}]*\} from '\.\/lib\/vitest-summary\.mjs'/);
    expect(source).not.toMatch(/function parseFailedFiles\s*\(/);
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
