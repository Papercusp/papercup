/**
 * mergeDistilledRuns — EI-18822211427354845.
 *
 * A multi-workspace `testing:run` is N separate `vitest run` invocations (one per owning
 * workspace config), so it produces N JSON reports. The tool used to read a single report
 * path and report that ONE group as the whole run. The incident: a RED operator-core file
 * (23 tests, 1 failed) plus a GREEN apps/operator file (7 passed) came back as
 * `passed:7, failed:0, failures:[]` — an empty failure list for a red tree.
 *
 * Lives in its own file rather than testing-run-store.test.ts: that suite fakes
 * node:child_process and calls resetModules per test to isolate the module-level run map,
 * and these are pure-function assertions that want neither.
 */
import { describe, expect, it } from 'vitest';
import { mergeDistilledRuns, type DistilledTestRun } from './testing-run-store';

function run(over: Partial<DistilledTestRun> = {}): DistilledTestRun {
  return {
    passed: 0, failed: 0, skipped: 0, files: 0,
    failures: [], failuresTruncated: false, durationMs: null, byFile: {},
    ...over,
  };
}

describe('mergeDistilledRuns', () => {
  it('reproduces the incident: a red group merged with a green one is NOT reported as green', () => {
    const redGroup = run({
      passed: 22, failed: 1, files: 1, durationMs: 3000,
      failures: [{ file: 'packages/operator-core/lib/endpoint-route/__tests__/launch-su.test.ts', test: 'live spawn path', message: 'boom' }],
    });
    const greenGroup = run({ passed: 7, files: 1, durationMs: 430 });

    const merged = mergeDistilledRuns([redGroup, greenGroup]);

    // The exact fields that lied: files was 1 for a 2-file request, and the red
    // group's failure was absent entirely.
    expect(merged.files).toBe(2);
    expect(merged.failed).toBe(1);
    expect(merged.passed).toBe(29);
    expect(merged.failures).toHaveLength(1);
    expect(merged.failures[0]!.file).toContain('launch-su.test.ts');
  });

  it('order does not matter — a red group LAST is reported the same as a red group FIRST', () => {
    // The old bug was last-writer-wins, so group order silently decided the verdict.
    const red = run({ failed: 1, files: 1, failures: [{ file: 'a.test.ts', test: 't', message: 'm' }] });
    const green = run({ passed: 7, files: 1 });
    expect(mergeDistilledRuns([red, green])).toEqual(mergeDistilledRuns([green, red]));
  });

  it('sums counts across any number of groups', () => {
    const merged = mergeDistilledRuns([
      run({ passed: 1, failed: 2, skipped: 3, files: 1 }),
      run({ passed: 10, failed: 20, skipped: 30, files: 2 }),
      run({ passed: 100, failed: 200, skipped: 300, files: 3 }),
    ]);
    expect(merged).toMatchObject({ passed: 111, failed: 222, skipped: 333, files: 6 });
  });

  it('sums durationMs because the router runs groups SEQUENTIALLY', () => {
    expect(mergeDistilledRuns([run({ durationMs: 3000 }), run({ durationMs: 430 })]).durationMs).toBe(3430);
  });

  it('reports durationMs null only when EVERY group reported null', () => {
    expect(mergeDistilledRuns([run(), run()]).durationMs).toBeNull();
    expect(mergeDistilledRuns([run(), run({ durationMs: 5 })]).durationMs).toBe(5);
  });

  it('re-applies maxFailures across the COMBINED list and flags the cut', () => {
    const mk = (n: number) => run({
      failed: n,
      failures: Array.from({ length: n }, (_, i) => ({ file: `f${i}.test.ts`, test: `t${i}`, message: 'm' })),
    });
    const merged = mergeDistilledRuns([mk(3), mk(3)], { maxFailures: 4 });
    expect(merged.failed).toBe(6);          // counts stay complete…
    expect(merged.failures).toHaveLength(4); // …only the returned list is capped
    expect(merged.failuresTruncated).toBe(true);
  });

  it('keeps failuresTruncated sticky when an input group was already truncated', () => {
    expect(mergeDistilledRuns([run({ failuresTruncated: true }), run()]).failuresTruncated).toBe(true);
  });

  it('an empty merge is an all-zero run, never a pass with phantom counts', () => {
    expect(mergeDistilledRuns([])).toEqual(run());
  });
});
