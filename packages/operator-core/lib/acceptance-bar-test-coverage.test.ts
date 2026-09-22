/**
 * R-7 guard for generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20 (P-007).
 *
 * R-7's falsifier, verbatim: "A bar in this plan's set has no committed test, or its
 * named test still passes when the behavior it pins is reverted."
 *
 * Both halves are checked here, and the second is the one that needs care: whether a
 * test would fail on reversion is a COUNTERFACTUAL, so it cannot be read off the test's
 * source. It was measured with `scripts/mutation-probe.sh` and the verdict is carried as
 * data in `ACCEPTANCE_BAR_TEST_COVERAGE`; this file checks that every required bar has a
 * mapping whose verdict is `caught` AND whose test is on disk AND tracked.
 *
 * ON VACUITY — the failure this file is most exposed to. A completeness check is trivial
 * to write so that it passes no matter what (iterate the entries, assert each entry
 * matches itself). The controls below are therefore not decoration: each one feeds the
 * SAME validator a map that is wrong in exactly ONE way and asserts it is rejected for
 * exactly that reason. CONTROL C is the load-bearing one — it is the difference between
 * "a test exists per bar" (which R-7 does not say) and "a test that fails on reversion
 * exists per bar" (which is what R-7 says).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_BAR_SET_HASH,
  ACCEPTANCE_BAR_TEST_COVERAGE,
  REQUIRED_BAR_KEYS,
  validateBarTestCoverage,
  type BarTestCoverageEntry,
} from './acceptance-bar-test-coverage';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const realFileExists = (path: string): boolean => existsSync(resolve(REPO_ROOT, path));

/**
 * "Committed" is the bar's own word, so presence on disk is not enough: a test that
 * exists only in my dirty working tree is coverage nobody else inherits. `git ls-files`
 * is asked ONCE for the whole set rather than per path.
 */
function trackedSet(paths: readonly string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const out = execFileSync('git', ['ls-files', '-z', '--', ...paths], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return new Set(out.split('\0').filter(Boolean));
}

const allTestPaths = ACCEPTANCE_BAR_TEST_COVERAGE.map((entry) => entry.testPath);
const tracked = trackedSet(allTestPaths);
const realIsTracked = (path: string): boolean => tracked.has(path);

/** A syntactically valid entry used to build the deliberately-wrong control maps. */
function entryFor(barKey: string, overrides: Partial<BarTestCoverageEntry> = {}): BarTestCoverageEntry {
  const real = ACCEPTANCE_BAR_TEST_COVERAGE.find((candidate) => candidate.barKey === barKey);
  if (!real) throw new Error(`control fixture needs a real ${barKey} entry to perturb`);
  return { ...real, ...overrides };
}

describe('R-7 — the instrument itself discriminates (permanent controls)', () => {
  /**
   * CALIBRATION. Without this, every control below could be passing because the
   * validator rejects EVERYTHING, which would make the controls agree with a
   * completely broken property.
   */
  it('CALIBRATION — a well-formed map is accepted by the same validator', () => {
    const report = validateBarTestCoverage({
      requiredBarKeys: ['R-1'],
      entries: [entryFor('R-1')],
      fileExists: () => true,
      isTracked: () => true,
    });
    expect(report.ok).toBe(true);
    expect(report.coveredBars).toEqual(['R-1']);
  });

  it('CONTROL A — a bar with NO mapping is reported as uncovered', () => {
    const report = validateBarTestCoverage({
      requiredBarKeys: ['R-1', 'R-4'],
      entries: [entryFor('R-1')],
      fileExists: () => true,
      isTracked: () => true,
    });
    expect(report.ok).toBe(false);
    expect(report.barsWithoutEntry).toEqual(['R-4']);
  });

  it('CONTROL B — a mapping pointing at a test that does not exist is rejected', () => {
    const report = validateBarTestCoverage({
      requiredBarKeys: ['R-1'],
      entries: [entryFor('R-1', { testPath: 'packages/operator-core/lib/does-not-exist.test.ts' })],
      fileExists: realFileExists,
      isTracked: () => true,
    });
    expect(report.ok).toBe(false);
    expect(report.missingTestFiles).toEqual(['packages/operator-core/lib/does-not-exist.test.ts']);
    expect(report.unfalsifiedBars).toEqual(['R-1']);
  });

  /**
   * CONTROL C — THE load-bearing control. A test that still passes once the behavior is
   * reverted is precisely what R-7's falsifier names, so a `survived` verdict must read
   * as "this bar is NOT covered", not as "covered, with a caveat".
   */
  it('CONTROL C — a mapping whose mutant SURVIVED does not count as coverage', () => {
    const report = validateBarTestCoverage({
      requiredBarKeys: ['R-1'],
      entries: [entryFor('R-1', { probeVerdict: 'survived' })],
      fileExists: () => true,
      isTracked: () => true,
    });
    expect(report.ok).toBe(false);
    expect(report.unfalsifiedBars).toEqual(['R-1']);
    expect(report.coveredBars).toEqual([]);
  });

  it('CONTROL D — an UNPROBED mapping is a claim, not coverage', () => {
    const report = validateBarTestCoverage({
      requiredBarKeys: ['R-1'],
      entries: [entryFor('R-1', { probeVerdict: 'not-probed' })],
      fileExists: () => true,
      isTracked: () => true,
    });
    expect(report.ok).toBe(false);
    expect(report.unfalsifiedBars).toEqual(['R-1']);
  });

  it('CONTROL E — a present but UNTRACKED test is not a committed test', () => {
    const report = validateBarTestCoverage({
      requiredBarKeys: ['R-1'],
      entries: [entryFor('R-1')],
      fileExists: () => true,
      isTracked: () => false,
    });
    expect(report.ok).toBe(false);
    expect(report.untrackedTestFiles).toEqual([entryFor('R-1').testPath]);
    expect(report.coveredBars).toEqual([]);
  });
});

describe('R-7 — the real bar set is covered by committed, falsifiable tests', () => {
  /**
   * Instrument check for the git leg, which is the one that can silently answer `true`
   * for everything. An absence claim needs a positive control: assert the real reader
   * separates a known-tracked path from a path that cannot be tracked.
   */
  it('the tracked-file reader discriminates (positive + negative control)', () => {
    const probe = trackedSet([
      'packages/operator-core/lib/acceptance-bar-test-coverage.ts',
      'packages/operator-core/lib/definitely-not-a-real-file.test.ts',
    ]);
    expect(probe.has('packages/operator-core/lib/acceptance-bar-test-coverage.ts')).toBe(true);
    expect(probe.has('packages/operator-core/lib/definitely-not-a-real-file.test.ts')).toBe(false);
  });

  it('every required bar has a committed test whose mutant was CAUGHT', () => {
    const report = validateBarTestCoverage({
      requiredBarKeys: REQUIRED_BAR_KEYS,
      entries: ACCEPTANCE_BAR_TEST_COVERAGE,
      fileExists: realFileExists,
      isTracked: realIsTracked,
    });
    // Assert on the detail lists BEFORE `ok`, so a failure names which bar broke rather
    // than only reporting that something did.
    expect(report.barsWithoutEntry).toEqual([]);
    expect(report.unfalsifiedBars).toEqual([]);
    expect(report.missingTestFiles).toEqual([]);
    expect(report.untrackedTestFiles).toEqual([]);
    expect(report.ok).toBe(true);
    expect([...report.coveredBars].sort()).toEqual([...REQUIRED_BAR_KEYS].sort());
  });

  it('every mapped subject exists, so each recorded mutation had something to revert', () => {
    const missingSubjects = ACCEPTANCE_BAR_TEST_COVERAGE.filter(
      (entry) => !realFileExists(entry.subjectPath),
    ).map((entry) => entry.subjectPath);
    expect(missingSubjects).toEqual([]);
  });

  it('every entry records the exact reversion its verdict was measured against', () => {
    const withoutMutation = ACCEPTANCE_BAR_TEST_COVERAGE.filter(
      (entry) => entry.mutation.trim().length === 0,
    ).map((entry) => entry.specId);
    expect(withoutMutation).toEqual([]);
  });

  it('maps only bars the plan actually declares', () => {
    const stray = ACCEPTANCE_BAR_TEST_COVERAGE.filter(
      (entry) => !REQUIRED_BAR_KEYS.includes(entry.barKey),
    ).map((entry) => entry.barKey);
    expect(stray).toEqual([]);
  });

  /**
   * PIN, not a copy: `REQUIRED_BAR_KEYS` is a second copy of a truth the plan's rubric
   * owns, so it is pinned to the bar-set revision it was derived from. If the rubric is
   * re-cut, the hash moves and this mapping must be re-derived rather than silently
   * continuing to certify a bar set that no longer exists.
   */
  it('is pinned to the bar-set revision it was derived from', () => {
    expect(ACCEPTANCE_BAR_SET_HASH).toBe(
      '9428e795bc141211363f822e86c6f621c8ec4fdb844c4f1eac46ca37213b123b',
    );
    expect(REQUIRED_BAR_KEYS).toEqual(['R-1', 'R-2', 'R-3', 'R-4', 'R-5', 'R-6', 'R-7']);
  });
});
