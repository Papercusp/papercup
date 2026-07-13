/**
 * red-test-green-resolve.test.ts — P-007 / WI-4601.
 *
 * This decides whether to AUTONOMOUSLY resolve a red-test watchdog EI, so the tests are
 * weighted on the SILENCES (each has a live incident or a live-data case behind it), not
 * the happy path:
 *   - it must NEVER resolve while the LATEST run is red (a regressed test stays open — the
 *     live data had files reading `fail,pass,pass,...`, green in one tree but just-failed
 *     in another; the merged latest status is red);
 *   - it must NEVER resolve on a single lucky pass after a flake (the live data had exactly
 *     one streak-of-1 among the currently-green files);
 *   - it must NEVER resolve on absence (no recent runs) — that is auto-close's job;
 *   - when it DOES resolve, it must attach REAL green-run evidence (verifiedHow:
 *     'already-passing'), never a bare assertion.
 */
import { describe, expect, it } from 'vitest';
import {
  consecutiveGreenStreak,
  decideRedTestGreenResolve,
  redTestPathOf,
  RED_TEST_GREEN_MIN_CONSECUTIVE,
  type RedTestRun,
} from './red-test-green-resolve';

const T = 1_700_000_000_000;
/** Build runs LATEST-FIRST from a status string like 'pass,pass,fail'. */
const runs = (statuses: string, sha = 'abc1234567'): RedTestRun[] =>
  statuses.split(',').map((status, i) => ({ status: status.trim(), startedAtMs: T - i * 60_000, commitSha: sha }));

const KEY = 'red-test:packages/operator-core/lib/foo.test.ts';

describe('redTestPathOf', () => {
  it('extracts the path from a red-test key and returns null for any other source', () => {
    expect(redTestPathOf(KEY)).toBe('packages/operator-core/lib/foo.test.ts');
    expect(redTestPathOf('repeated-tool-error:some:thing')).toBeNull();
    expect(redTestPathOf('smoke-fail:papercup')).toBeNull();
    expect(redTestPathOf(undefined)).toBeNull();
  });
});

describe('consecutiveGreenStreak', () => {
  it('counts leading passes from the latest and stops at the first non-pass', () => {
    expect(consecutiveGreenStreak(runs('pass,pass,pass'))).toBe(3);
    expect(consecutiveGreenStreak(runs('pass,fail,pass,pass'))).toBe(1);
    expect(consecutiveGreenStreak(runs('fail,pass,pass'))).toBe(0);
    // an ERROR breaks the streak exactly like a fail
    expect(consecutiveGreenStreak(runs('pass,error,pass'))).toBe(1);
    expect(consecutiveGreenStreak([])).toBe(0);
  });
});

describe('decideRedTestGreenResolve — the silences', () => {
  it('RESOLVES a proven-green test (≥N consecutive passes) WITH real green-run evidence', () => {
    const d = decideRedTestGreenResolve(KEY, runs('pass,pass,pass,pass,pass'), { minConsecutiveGreens: 3 });
    expect(d.resolve).toBe(true);
    expect(d.greenStreak).toBe(5);
    expect(d.evidence?.verifiedHow).toBe('already-passing');
    expect(d.evidence?.addedTests).toBe(false);
    // Evidence must be CONCRETE — the file, the streak, and the run identity, not a bare "green".
    expect(d.evidence?.testsRun).toContain('packages/operator-core/lib/foo.test.ts');
    expect(d.evidence?.testsRun).toContain('5 consecutive');
    expect(d.evidence?.testsRun).toContain('abc12345'); // short commit sha
    expect(d.evidence?.testResult).toBe('pass (5/5 consecutive green)');
    expect(d.completionRef).toContain('POSITIVE green-run evidence');
    expect(d.completionRef).toContain('NOT mere signal-absence');
  });

  it('resolves at EXACTLY the threshold', () => {
    expect(decideRedTestGreenResolve(KEY, runs('pass,pass,pass'), { minConsecutiveGreens: 3 }).resolve).toBe(true);
  });

  it('NEVER resolves while the latest run is red — a regressed test stays open', () => {
    // Green in an older run but failing NOW (the `fail,pass,pass,pass` live case).
    const d = decideRedTestGreenResolve(KEY, runs('fail,pass,pass,pass,pass'), { minConsecutiveGreens: 3 });
    expect(d.resolve).toBe(false);
    expect(d.reason).toBe('latest-not-green');
    expect(d.greenStreak).toBe(0);
    expect(d.evidence).toBeUndefined();
  });

  it('NEVER resolves on a single lucky pass after a flake (< N consecutive)', () => {
    const d = decideRedTestGreenResolve(KEY, runs('pass,fail,fail,fail'), { minConsecutiveGreens: 3 });
    expect(d.resolve).toBe(false);
    expect(d.reason).toContain('insufficient-consecutive-greens');
    expect(d.greenStreak).toBe(1);
    expect(d.evidence).toBeUndefined();
  });

  it('NEVER resolves on ABSENCE (no recent runs) — that is the absence path, not green evidence', () => {
    const d = decideRedTestGreenResolve(KEY, [], { minConsecutiveGreens: 3 });
    expect(d.resolve).toBe(false);
    expect(d.reason).toBe('no-recent-runs');
  });

  it('NEVER resolves a non-red-test source (no positive test signal exists)', () => {
    const d = decideRedTestGreenResolve('repeated-tool-error:foo:structural', runs('pass,pass,pass'), {});
    expect(d.resolve).toBe(false);
    expect(d.reason).toBe('not-red-test');
  });

  it('defaults the threshold to RED_TEST_GREEN_MIN_CONSECUTIVE (3) when unset', () => {
    expect(RED_TEST_GREEN_MIN_CONSECUTIVE).toBe(3);
    expect(decideRedTestGreenResolve(KEY, runs('pass,pass')).resolve).toBe(false); // 2 < 3
    expect(decideRedTestGreenResolve(KEY, runs('pass,pass,pass')).resolve).toBe(true); // 3 ≥ 3
  });
});
