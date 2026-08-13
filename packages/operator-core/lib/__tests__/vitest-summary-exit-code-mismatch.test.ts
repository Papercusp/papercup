/**
 * vitest-summary-exit-code-mismatch.test.ts — EI-18653696921091778 regression guard,
 * extended by EI-18819483316574031 (the ANSI blindness that disabled it in production).
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
 * 2026-07-27 (EI-18819483316574031): that cross-check had never once fired on real
 * gate output, because every matcher was line-anchored while vitest COLOURISES the
 * summary rows. The guard was dead code in production and the green pin advanced over
 * a deterministic operator-vite failure. The ANSI cases below are the regression guard.
 *
 * These tests exercise the REAL helper + assert the runner actually wires it in.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Declarations are GENERATED (`npm run gen:declarations`, WI-6441) — the
// `@ts-expect-error` that used to sit here is gone rather than left behind, because an
// unused one is itself a TS2578 error once the module gains types.
import { parseSummaryFailedCounts, parseFailedTestFiles } from '../../../../scripts/lib/vitest-summary.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

/**
 * EI-18819483316574031 — VERBATIM bytes from the gate run that advanced the green pin
 * over a real, deterministic failure (candidate e1e2dfdbbcda, 2026-07-27T17:17Z,
 * ~/.papercusp/checkpoint-logs/2026-07-27T17-17-31-003Z-...-cand-e1e2dfdbbcda.log,
 * lines 273/274 and the operator-vite rollup row).
 *
 * These are NOT hand-written approximations of "what vitest probably prints" — that is
 * precisely the mistake that let this bug live: every pre-existing case in this file uses
 * clean, uncoloured text, so the parser looked correct while being blind on real output.
 * Escapes are written as explicit \x1b rather than raw ESC bytes so they stay visible
 * and survive formatters (a raw control byte in a fixture is invisible and easy to lose).
 */
const REAL_ANSI_SUMMARY =
  '\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m161 passed\x1b[39m\x1b[22m\x1b[90m (162)\x1b[39m\n' +
  '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m1598 passed\x1b[39m\x1b[22m\x1b[90m (1599)\x1b[39m\n';

const REAL_ANSI_ROLLUP =
  ' \x1b[31m❯\x1b[39m src/components/adv/learning-empty-state-copy.guard.test.ts \x1b[2m(\x1b[22m\x1b[2m5 tests\x1b[22m\x1b[2m | \x1b[22m\x1b[31m1 failed\x1b[39m\x1b[2m)\x1b[22m\x1b[32m 15\x1b[2mms\x1b[22m\x1b[39m\n';

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
      '\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m162 passed\x1b[39m\x1b[22m\x1b[90m (162)\x1b[39m\n' +
      '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m1599 passed\x1b[39m\x1b[22m\x1b[90m (1599)\x1b[39m\n';
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
    const failRow =
      '\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m \x1b[36msrc/components/adv/x.test.ts\x1b[39m\n';
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
  const source = readFileSync(AFFECTED_TESTS, 'utf8').replaceAll('"', "'");

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

/**
 * WI-6441 — the THIRD reader of vitest output.
 *
 * EI-18819483316574031 consolidated `affected-tests.mjs` (above) onto the shared seam,
 * but `green-checkpoint.ts` kept its own `stripAnsi` + its own test-file/rollup/suite
 * regexes. That is the precise configuration the incident was about: green-checkpoint
 * HAD the ANSI strip and its sibling did not, and the only thing asserting they matched
 * was a comment claiming they were "in lock-step" — which had been false for weeks while
 * the gate's last line of defence sat dead in production.
 *
 * Note what is deliberately NOT asserted here: that the two parsers produce equal output.
 * They must not — `parseFailedTestFiles` returns a flat file list and
 * `parseFailingFilesByWorkspace` returns per-workspace attribution with rollup-over-FAIL
 * precedence. Only the SHARED SUB-EXPRESSIONS are shared; the divergent logic stays local.
 * An equality test would either force a false merge of the two behaviours or pass
 * vacuously, and neither would have caught the original drift.
 */
describe('green-checkpoint.ts reads vitest output through the shared seam (WI-6441)', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'apps/operator/lib/release/green-checkpoint.ts'), 'utf8');

  it('imports the shared ANSI strip + row matchers rather than redefining them', () => {
    expect(source).toMatch(
      /import \{[^}]*\bstripVitestAnsi\b[^}]*\} from ["']\.\.\/\.\.\/\.\.\/\.\.\/scripts\/lib\/vitest-summary\.mjs["']/s,
    );
    expect(source).toMatch(/\bvitestSummaryFailRow\b/);
    expect(source).toMatch(/\bvitestSuiteFailRow\b/);
  });

  // The negative control. Without these three, the assertions above pass just as happily
  // with the old private copies still sitting in the file next to the new import — i.e.
  // they would confirm the seam EXISTS while the drift it prevents continued unchanged.
  it('keeps no private copy of the regexes the shared module now owns', () => {
    // The SGR strip: one implementation, or the next fix propagates to one of them again.
    expect(source).not.toMatch(/replace\(\/\\x1b\\\[\[0-9;\]\*m\/g/);
    // The test-file path shape, previously duplicated as a local `TEST_FILE` const.
    expect(source).not.toMatch(/\\\.\(\?:test\|spec\)\\\./);
  });
});
