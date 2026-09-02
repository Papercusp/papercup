/**
 * patch-coverage.test.ts — P-009 part (c), plan design-to-code-coverage-seam-2026-09-02.
 *
 * ⛔ THE THING THESE TESTS EXIST FOR: a patch-coverage gate fed by an absent or
 * partial lcov does not fail — it reports 100% and goes GREEN, because "no
 * uncovered changed lines" and "nothing was measured" are the same observation
 * unless they are named apart. That vacuous pass is why WI-2142119's stated
 * premise ("fed by the lcov P-007 emits") had to be corrected before any code was
 * written: P-007 shipped no producer, so the gate as specified would have been
 * green from birth while measuring nothing.
 *
 * So the assertions below are weighted toward the NON-PASSING outcomes. The
 * `undetermined` cases are the load-bearing ones — a change that quietly turned
 * them into `pass` would leave every other test in this file still green.
 */
import { describe, it, expect } from 'vitest';
import { parseLcov, indexBySourceFile } from '../../../scripts/lib/lcov-merge.ts';
import {
  isCoverableSourcePath,
  judgePatchCoverage,
  parseAddedLines,
} from '../../../scripts/lib/patch-coverage.ts';

const coverageOf = (lcov: string) => indexBySourceFile(parseLcov(lcov));

/** src/a.ts: line 10 covered, line 11 uncovered, line 30 covered. */
const LCOV = [
  'SF:src/a.ts',
  'DA:10,3',
  'DA:11,0',
  'DA:30,1',
  'end_of_record',
  'SF:src/b.ts',
  'DA:5,0',
  'end_of_record',
].join('\n');

describe('parseAddedLines', () => {
  it('reads added line numbers from a --unified=0 diff', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -9,0 +10,2 @@',
      '+const x = 1;',
      '+const y = 2;',
      '@@ -28,0 +30 @@',
      '+const z = 3;',
    ].join('\n');
    expect(parseAddedLines(diff).get('src/a.ts')).toEqual(new Set([10, 11, 30]));
  });

  it('stays correct when the diff carries CONTEXT lines', () => {
    // The CLI passes --unified=0, but a caller-supplied --diff-file may not.
    const diff = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -8,4 +8,5 @@',
      ' const before = 0;',
      '+const added = 1;',
      ' const after = 2;',
      '-const removed = 3;',
      '+const alsoAdded = 4;',
    ].join('\n');
    // 8 context, 9 added, 10 context, removed advances nothing, 11 added.
    expect(parseAddedLines(diff).get('src/a.ts')).toEqual(new Set([9, 11]));
  });

  it('skips a DELETED file — a removed line can never be covered', () => {
    const diff = [
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-const a = 1;',
      '-const b = 2;',
    ].join('\n');
    expect(parseAddedLines(diff).size).toBe(0);
  });

  it('handles --no-prefix output (no leading `b/`)', () => {
    const diff = ['--- src/a.ts', '+++ src/a.ts', '@@ -0,0 +1 @@', '+const a = 1;'].join('\n');
    expect(parseAddedLines(diff).get('src/a.ts')).toEqual(new Set([1]));
  });
});

describe('isCoverableSourcePath', () => {
  it.each([
    ['packages/operator-core/lib/x.ts', true],
    ['apps/operator/app/page.tsx', true],
    ['scripts/lib/thing.mjs', true],
    ['packages/operator-core/lib/x.test.ts', false],
    ['apps/operator/e2e/flow.spec.ts', false],
    ['scripts/lib/thing.d.mts', false],
    ['docs/plans/whatever.md', false],
    ['libs/papercusp/libs/db/sql/800-x.sql', false],
    ['node_modules/dep/index.js', false],
    ['packages/x/dist/bundle.js', false],
  ])('%s -> %s', (path, expected) => {
    expect(isCoverableSourcePath(path)).toBe(expected);
  });
});

describe('judgePatchCoverage — the non-passing outcomes (the point of the gate)', () => {
  it('an EMPTY coverage index is UNDETERMINED, never 100%', () => {
    const verdict = judgePatchCoverage({
      changed: new Map([['src/a.ts', new Set([10, 11])]]),
      coverage: new Map(),
      thresholdPct: 80,
    });
    expect(verdict.status).toBe('undetermined');
    expect(verdict.percent).toBeNull();
    expect(verdict.notes.join('\n')).toMatch(/EMPTY/);
  });

  it('a changed source file with NO coverage record is UNDETERMINED, not 0% and not covered', () => {
    // 0% would be a false RED for a file no suite instruments; "covered" is the
    // vacuous pass. Naming it is the only honest third answer.
    const verdict = judgePatchCoverage({
      changed: new Map([['src/never-instrumented.ts', new Set([1])]]),
      coverage: coverageOf(LCOV),
      thresholdPct: 80,
    });
    expect(verdict.status).toBe('undetermined');
    expect(verdict.filesWithoutCoverageData).toEqual(['src/never-instrumented.ts']);
  });

  it('one unmeasured file makes the WHOLE verdict undetermined, even beside covered ones', () => {
    const verdict = judgePatchCoverage({
      changed: new Map([
        ['src/a.ts', new Set([10, 30])], // both covered
        ['src/missing.ts', new Set([1])],
      ]),
      coverage: coverageOf(LCOV),
      thresholdPct: 80,
    });
    expect(verdict.status).toBe('undetermined');
    expect(verdict.coveredLines).toBe(2);
  });

  it('fails when measured coverage is below the threshold', () => {
    const verdict = judgePatchCoverage({
      changed: new Map([['src/a.ts', new Set([10, 11])]]),
      coverage: coverageOf(LCOV),
      thresholdPct: 80,
    });
    expect(verdict.status).toBe('fail');
    expect(verdict.percent).toBe(50);
    expect(verdict.uncovered).toEqual([{ file: 'src/a.ts', line: 11 }]);
  });
});

describe('judgePatchCoverage — passing outcomes, each stated rather than implied', () => {
  it('passes when every added executable line is covered', () => {
    const verdict = judgePatchCoverage({
      changed: new Map([['src/a.ts', new Set([10, 30])]]),
      coverage: coverageOf(LCOV),
      thresholdPct: 80,
    });
    expect(verdict.status).toBe('pass');
    expect(verdict.percent).toBe(100);
  });

  it('excludes NON-EXECUTABLE added lines from the denominator, not counts them uncovered', () => {
    // Lines 1-3 of src/a.ts are absent from DA: comments, imports, blank lines.
    // Counting them would fail a gate about tests on a comment-only edit.
    const verdict = judgePatchCoverage({
      changed: new Map([['src/a.ts', new Set([1, 2, 3, 10])]]),
      coverage: coverageOf(LCOV),
      thresholdPct: 100,
    });
    expect(verdict.status).toBe('pass');
    expect(verdict.coveredLines).toBe(1);
    expect(verdict.uncoveredLines).toBe(0);
  });

  it('reports a test-only / docs-only change as no-coverable-lines, NOT as 100%', () => {
    const verdict = judgePatchCoverage({
      changed: new Map([
        ['packages/operator-core/lib/x.test.ts', new Set([1])],
        ['docs/plans/p.md', new Set([1])],
      ]),
      coverage: coverageOf(LCOV),
      thresholdPct: 80,
    });
    expect(verdict.status).toBe('no-coverable-lines');
    expect(verdict.percent).toBeNull();
    expect(verdict.filesConsidered).toEqual([]);
    expect(verdict.filesSkipped).toHaveLength(2);
  });

  it('reports a source file whose added lines are all non-executable distinctly from a pass', () => {
    const verdict = judgePatchCoverage({
      changed: new Map([['src/a.ts', new Set([1, 2])]]),
      coverage: coverageOf(LCOV),
      thresholdPct: 80,
    });
    expect(verdict.status).toBe('no-coverable-lines');
    expect(verdict.percent).toBeNull();
    expect(verdict.notes.join('\n')).toMatch(/none of the added lines are/);
  });

  it('the threshold is honoured exactly at the boundary', () => {
    // src/a.ts:10 covered, :11 uncovered -> 50%.
    const at = judgePatchCoverage({
      changed: new Map([['src/a.ts', new Set([10, 11])]]),
      coverage: coverageOf(LCOV),
      thresholdPct: 50,
    });
    expect(at.status).toBe('pass');
  });
});
