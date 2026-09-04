import { describe, expect, it, vi } from 'vitest';

import {
  computeCoverageDelta,
  describeCoverLoopVerdict,
  isCoverLoopVerdictConclusive,
  judgeCoverLoop,
  runCoverLoop,
  type CoverageRecord,
  type CoverLoopRunners,
} from './qodo-cover-loop.ts';

/** Build a coverage record: line number -> hit count. */
function rec(sourceFile: string, lines: Record<number, number>): CoverageRecord {
  return {
    sourceFile,
    lines: new Map(Object.entries(lines).map(([line, hits]) => [Number(line), hits])),
  };
}

const PASSING_BUILD = { ok: true as const };
const PASSING_TESTS = { ok: true as const, testsRun: 1 };

describe('computeCoverageDelta', () => {
  it('reports lines that went from unhit to hit', () => {
    const delta = computeCoverageDelta(
      [rec('lib/a.ts', { 1: 1, 2: 0, 3: 0 })],
      [rec('lib/a.ts', { 1: 1, 2: 4, 3: 0 })],
    );

    expect(delta.conclusive).toBe(true);
    expect(delta.newlyCoveredLines).toBe(1);
    expect(delta.newlyCoveredByFile).toEqual([{ file: 'lib/a.ts', lines: [2] }]);
  });

  it('counts a line absent from the baseline as newly covered', () => {
    const delta = computeCoverageDelta(
      [rec('lib/a.ts', { 1: 1 })],
      [rec('lib/a.ts', { 1: 1, 9: 2 })],
    );

    expect(delta.newlyCoveredLines).toBe(1);
    expect(delta.newlyCoveredByFile).toEqual([{ file: 'lib/a.ts', lines: [9] }]);
  });

  it('reports a genuine zero delta as CONCLUSIVE', () => {
    const delta = computeCoverageDelta(
      [rec('lib/a.ts', { 1: 1, 2: 1 })],
      [rec('lib/a.ts', { 1: 3, 2: 2 })],
    );

    expect(delta.conclusive).toBe(true);
    expect(delta.inconclusiveReason).toBeNull();
    expect(delta.newlyCoveredLines).toBe(0);
  });

  it('sorts newly covered lines ascending and files by path', () => {
    const delta = computeCoverageDelta(
      [rec('lib/b.ts', { 5: 0, 1: 0 }), rec('lib/a.ts', { 3: 0 })],
      [rec('lib/b.ts', { 5: 1, 1: 1 }), rec('lib/a.ts', { 3: 1 })],
    );

    expect(delta.newlyCoveredByFile).toEqual([
      { file: 'lib/a.ts', lines: [3] },
      { file: 'lib/b.ts', lines: [1, 5] },
    ]);
  });

  it('merges duplicate records for one file by max hit count', () => {
    // A line hit by either record is hit — so this is NOT newly covered.
    const delta = computeCoverageDelta(
      [rec('lib/a.ts', { 1: 0 }), rec('lib/a.ts', { 1: 7 })],
      [rec('lib/a.ts', { 1: 2 })],
    );

    expect(delta.newlyCoveredLines).toBe(0);
    expect(delta.baselineFiles).toBe(1);
  });

  it('counts a present-but-unhit line as a regression', () => {
    const delta = computeCoverageDelta(
      [rec('lib/a.ts', { 1: 3 })],
      [rec('lib/a.ts', { 1: 0 })],
    );

    expect(delta.regressedLines).toBe(1);
    expect(delta.unmeasuredInCandidate).toBe(0);
  });

  it('counts an ABSENT line as unmeasured, not as a regression', () => {
    // The distinction that stops the loop inventing regressions out of files
    // the candidate run simply did not instrument.
    const delta = computeCoverageDelta(
      [rec('lib/a.ts', { 1: 3 }), rec('lib/b.ts', { 4: 2 })],
      [rec('lib/a.ts', { 1: 3 })],
    );

    expect(delta.regressedLines).toBe(0);
    expect(delta.unmeasuredInCandidate).toBe(1);
  });

  it('counts measuredLines as the union across both snapshots', () => {
    const delta = computeCoverageDelta(
      [rec('lib/a.ts', { 1: 1, 2: 0 })],
      [rec('lib/a.ts', { 2: 1, 3: 1 })],
    );

    expect(delta.measuredLines).toBe(3);
  });

  describe('inconclusive inputs are never reported as a zero delta', () => {
    it.each([
      ['baseline-missing', null, [rec('lib/a.ts', { 1: 1 })]],
      ['candidate-missing', [rec('lib/a.ts', { 1: 1 })], null],
      ['baseline-empty', [], [rec('lib/a.ts', { 1: 1 })]],
      ['candidate-empty', [rec('lib/a.ts', { 1: 1 })], []],
    ] as const)('%s', (reason, baseline, candidate) => {
      const delta = computeCoverageDelta(baseline, candidate);

      expect(delta.conclusive).toBe(false);
      expect(delta.inconclusiveReason).toBe(reason);
      // The trap: the count reads zero in both the conclusive and the
      // inconclusive case, which is why `conclusive` has to be consulted.
      expect(delta.newlyCoveredLines).toBe(0);
    });
  });

  it('treats records carrying zero executable lines as empty, not as measured', () => {
    const delta = computeCoverageDelta([rec('lib/a.ts', {})], [rec('lib/a.ts', { 1: 1 })]);

    expect(delta.conclusive).toBe(false);
    expect(delta.inconclusiveReason).toBe('baseline-empty');
  });
});

describe('judgeCoverLoop', () => {
  it('keeps a candidate that builds, passes and raises coverage', () => {
    const verdict = judgeCoverLoop({
      build: PASSING_BUILD,
      tests: PASSING_TESTS,
      baseline: [rec('lib/a.ts', { 1: 0 })],
      candidate: [rec('lib/a.ts', { 1: 1 })],
    });

    expect(verdict.decision).toBe('keep');
    expect(verdict.legs).toEqual({ builds: 'pass', passes: 'pass', raisesCoverage: 'pass' });
    expect(verdict.discardReason).toBeNull();
  });

  it('DISCARDS a candidate that builds and passes but gains nothing', () => {
    // The case this loop exists for, and the one the patch-coverage gate would
    // have passed vacuously (D-048): passing alone is never sufficient.
    const verdict = judgeCoverLoop({
      build: PASSING_BUILD,
      tests: PASSING_TESTS,
      baseline: [rec('lib/a.ts', { 1: 1, 2: 1 })],
      candidate: [rec('lib/a.ts', { 1: 9, 2: 9 })],
    });

    expect(verdict.decision).toBe('discard');
    expect(verdict.discardReason).toBe('no-coverage-gain');
    expect(verdict.legs.passes).toBe('pass');
    expect(verdict.legs.raisesCoverage).toBe('fail');
  });

  it('discards a candidate that does not build, and reports later legs as undetermined', () => {
    const verdict = judgeCoverLoop({
      build: { ok: false, detail: 'TS2304: Cannot find name' },
      tests: { ok: null },
      baseline: null,
      candidate: null,
    });

    expect(verdict.decision).toBe('discard');
    expect(verdict.discardReason).toBe('build-failed');
    // Not `fail` — the later legs were never run, and saying `fail` would
    // claim a measurement that never happened.
    expect(verdict.legs.passes).toBe('undetermined');
    expect(verdict.legs.raisesCoverage).toBe('undetermined');
    expect(verdict.reason).toContain('TS2304');
  });

  it('discards a candidate whose test fails', () => {
    const verdict = judgeCoverLoop({
      build: PASSING_BUILD,
      tests: { ok: false, testsRun: 1, detail: 'expected 1 to be 2' },
      baseline: null,
      candidate: null,
    });

    expect(verdict.decision).toBe('discard');
    expect(verdict.discardReason).toBe('tests-failed');
    expect(verdict.legs.raisesCoverage).toBe('undetermined');
  });

  it('refuses a vacuous green: ok with zero tests run is UNDETERMINED, not a pass', () => {
    const verdict = judgeCoverLoop({
      build: PASSING_BUILD,
      tests: { ok: true, testsRun: 0 },
      baseline: [rec('lib/a.ts', { 1: 0 })],
      candidate: [rec('lib/a.ts', { 1: 1 })],
    });

    expect(verdict.decision).toBe('undetermined');
    expect(verdict.legs.passes).toBe('undetermined');
    expect(verdict.reason).toContain('vacuous');
  });

  it.each([
    ['build', { build: { ok: null }, tests: PASSING_TESTS }],
    ['test', { build: PASSING_BUILD, tests: { ok: null } }],
  ] as const)('reports an undetermined %s leg as undetermined, never as a discard', (_leg, legs) => {
    const verdict = judgeCoverLoop({ ...legs, baseline: null, candidate: null });

    expect(verdict.decision).toBe('undetermined');
    expect(verdict.discardReason).toBeNull();
  });

  it('always reports all three legs', () => {
    const verdicts = [
      judgeCoverLoop({ build: { ok: false }, tests: { ok: null }, baseline: null, candidate: null }),
      judgeCoverLoop({ build: PASSING_BUILD, tests: { ok: false }, baseline: null, candidate: null }),
      judgeCoverLoop({
        build: PASSING_BUILD,
        tests: PASSING_TESTS,
        baseline: [rec('a.ts', { 1: 0 })],
        candidate: [rec('a.ts', { 1: 1 })],
      }),
    ];

    for (const verdict of verdicts) {
      expect(Object.keys(verdict.legs).sort()).toEqual(['builds', 'passes', 'raisesCoverage']);
    }
  });

  describe('the D-048 distinction: zero gain vs unmeasurable gain', () => {
    const shared = { build: PASSING_BUILD, tests: PASSING_TESTS };

    it('a MEASURED zero gain discards', () => {
      const verdict = judgeCoverLoop({
        ...shared,
        baseline: [rec('lib/a.ts', { 1: 1 })],
        candidate: [rec('lib/a.ts', { 1: 1 })],
      });

      expect(verdict.decision).toBe('discard');
      expect(verdict.delta?.newlyCoveredLines).toBe(0);
    });

    it('an UNMEASURABLE gain is undetermined — same count, opposite meaning', () => {
      const verdict = judgeCoverLoop({ ...shared, baseline: null, candidate: null });

      expect(verdict.decision).toBe('undetermined');
      expect(verdict.delta?.newlyCoveredLines).toBe(0);
      expect(verdict.delta?.conclusive).toBe(false);
      expect(verdict.legs.raisesCoverage).toBe('undetermined');
      expect(verdict.reason).toContain('NOT a zero delta');
    });

    it('the two cases are distinguishable from the verdict alone', () => {
      const measured = judgeCoverLoop({
        ...shared,
        baseline: [rec('lib/a.ts', { 1: 1 })],
        candidate: [rec('lib/a.ts', { 1: 1 })],
      });
      const unmeasurable = judgeCoverLoop({ ...shared, baseline: null, candidate: null });

      expect(measured.delta?.newlyCoveredLines).toBe(unmeasurable.delta?.newlyCoveredLines);
      expect(measured.decision).not.toBe(unmeasurable.decision);
      expect(isCoverLoopVerdictConclusive(measured)).toBe(true);
      expect(isCoverLoopVerdictConclusive(unmeasurable)).toBe(false);
    });
  });

  it('notes a coverage regression without changing a keep verdict', () => {
    const verdict = judgeCoverLoop({
      build: PASSING_BUILD,
      tests: PASSING_TESTS,
      baseline: [rec('lib/a.ts', { 1: 1, 2: 0 })],
      candidate: [rec('lib/a.ts', { 1: 0, 2: 1 })],
    });

    expect(verdict.decision).toBe('keep');
    expect(verdict.notes.join(' ')).toContain('unhit in the candidate run');
  });
});

describe('isCoverLoopVerdictConclusive', () => {
  it('is true for keep and discard, false for undetermined', () => {
    const keep = judgeCoverLoop({
      build: PASSING_BUILD,
      tests: PASSING_TESTS,
      baseline: [rec('a.ts', { 1: 0 })],
      candidate: [rec('a.ts', { 1: 1 })],
    });
    const discard = judgeCoverLoop({
      build: { ok: false },
      tests: { ok: null },
      baseline: null,
      candidate: null,
    });
    const undetermined = judgeCoverLoop({
      build: { ok: null },
      tests: { ok: null },
      baseline: null,
      candidate: null,
    });

    expect(isCoverLoopVerdictConclusive(keep)).toBe(true);
    expect(isCoverLoopVerdictConclusive(discard)).toBe(true);
    expect(isCoverLoopVerdictConclusive(undetermined)).toBe(false);
  });
});

describe('describeCoverLoopVerdict', () => {
  it('names the decision, all three legs, and the gain', () => {
    const line = describeCoverLoopVerdict(
      judgeCoverLoop({
        build: PASSING_BUILD,
        tests: PASSING_TESTS,
        baseline: [rec('a.ts', { 1: 0 })],
        candidate: [rec('a.ts', { 1: 1 })],
      }),
    );

    expect(line).toContain('KEEP');
    expect(line).toContain('builds=pass');
    expect(line).toContain('passes=pass');
    expect(line).toContain('raisesCoverage=pass');
    expect(line).toContain('+1 line(s)');
  });

  it('omits a gain figure when the delta was not measured', () => {
    const line = describeCoverLoopVerdict(
      judgeCoverLoop({ build: { ok: null }, tests: { ok: null }, baseline: null, candidate: null }),
    );

    expect(line).toContain('UNDETERMINED');
    expect(line).not.toContain('line(s)');
  });
});

describe('runCoverLoop', () => {
  function runners(overrides: Partial<CoverLoopRunners<string>> = {}): CoverLoopRunners<string> {
    return {
      build: vi.fn(async () => ({ ok: true as const })),
      runTests: vi.fn(async () => ({ ok: true as const, testsRun: 1 })),
      baselineCoverage: vi.fn(async () => [rec('lib/a.ts', { 1: 0 })]),
      candidateCoverage: vi.fn(async () => [rec('lib/a.ts', { 1: 1 })]),
      ...overrides,
    };
  }

  it('keeps a candidate that clears all three legs', async () => {
    const verdict = await runCoverLoop('candidate.test.ts', runners());

    expect(verdict.decision).toBe('keep');
    expect(verdict.delta?.newlyCoveredLines).toBe(1);
  });

  it('short-circuits before coverage when the build fails', async () => {
    const r = runners({ build: vi.fn(async () => ({ ok: false as const, detail: 'boom' })) });

    const verdict = await runCoverLoop('candidate.test.ts', r);

    expect(verdict.decision).toBe('discard');
    expect(verdict.discardReason).toBe('build-failed');
    expect(r.runTests).not.toHaveBeenCalled();
    expect(r.baselineCoverage).not.toHaveBeenCalled();
    expect(r.candidateCoverage).not.toHaveBeenCalled();
  });

  it('short-circuits before coverage when the test fails', async () => {
    const r = runners({ runTests: vi.fn(async () => ({ ok: false as const, testsRun: 1 })) });

    const verdict = await runCoverLoop('candidate.test.ts', r);

    expect(verdict.decision).toBe('discard');
    expect(verdict.discardReason).toBe('tests-failed');
    expect(r.baselineCoverage).not.toHaveBeenCalled();
  });

  it('short-circuits on a vacuous green (zero tests run)', async () => {
    const r = runners({ runTests: vi.fn(async () => ({ ok: true as const, testsRun: 0 })) });

    const verdict = await runCoverLoop('candidate.test.ts', r);

    expect(verdict.decision).toBe('undetermined');
    expect(r.baselineCoverage).not.toHaveBeenCalled();
  });

  it('treats a THROWING build runner as undetermined, never as a failure', async () => {
    const r = runners({
      build: vi.fn(async () => {
        throw new Error('typechecker crashed');
      }),
    });

    const verdict = await runCoverLoop('candidate.test.ts', r);

    // A broken measurement is not evidence against the candidate.
    expect(verdict.decision).toBe('undetermined');
    expect(verdict.discardReason).toBeNull();
    expect(verdict.notes.join(' ')).toContain('typechecker crashed');
  });

  it('treats a THROWING coverage runner as an inconclusive delta, not a zero one', async () => {
    const r = runners({
      candidateCoverage: vi.fn(async () => {
        throw new Error('lcov missing');
      }),
    });

    const verdict = await runCoverLoop('candidate.test.ts', r);

    expect(verdict.decision).toBe('undetermined');
    expect(verdict.delta?.conclusive).toBe(false);
    expect(verdict.delta?.inconclusiveReason).toBe('candidate-missing');
  });

  it('runs the legs in order: build, tests, then both coverage snapshots', async () => {
    const calls: string[] = [];
    const r: CoverLoopRunners<string> = {
      build: async () => (calls.push('build'), { ok: true }),
      runTests: async () => (calls.push('tests'), { ok: true, testsRun: 1 }),
      baselineCoverage: async () => (calls.push('baseline'), [rec('a.ts', { 1: 0 })]),
      candidateCoverage: async () => (calls.push('candidate'), [rec('a.ts', { 1: 1 })]),
    };

    await runCoverLoop('candidate.test.ts', r);

    expect(calls).toEqual(['build', 'tests', 'baseline', 'candidate']);
  });
});
