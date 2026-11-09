import { describe, expect, it } from 'vitest';

import {
  LLM_TEST_EXIT_FAILED,
  LLM_TEST_EXIT_NOTHING_RAN,
  LLM_TEST_EXIT_OK,
  llmTestExitCode,
  runSummaryLine,
  scenarioExecutionVerdict,
  scenarioReportHeadline,
  tallyOutcomes,
  type ScenarioOutcome,
} from './run-exit-code';

describe('scenario report headline and CI outcome', () => {
  it.each(['failed', 'errored'] as const)('does not label an aggregate pass green when a repeat is %s', (status) => {
    const report = { verdict: 'pass' as const, runs: [{ status: 'passed' as const }, { status }, { status: 'passed' as const }] };
    expect(scenarioExecutionVerdict(report)).toBe(status === 'failed' ? 'fail' : 'errored');
    expect(scenarioReportHeadline(report)).toBe(status === 'failed'
      ? '  ✗ verdict=fail aggregateVerdict=pass (3 runs)'
      : '  ! verdict=errored aggregateVerdict=pass (3 runs)');
    expect(llmTestExitCode([scenarioExecutionVerdict(report) === 'pass' ? 'executed' : 'failed'])).toBe(1);
  });

  it.each(['pass', 'preview'] as const)('preserves a healthy %s label', (verdict) => {
    const report = { verdict, runs: [{ status: 'passed' as const }] };
    expect(scenarioExecutionVerdict(report)).toBe(verdict);
    expect(scenarioReportHeadline(report)).toBe(`  ${verdict === 'pass' ? '✓' : '○'} verdict=${verdict} (1 run)`);
  });

  it('preserves preview as the aggregate label while showing its failed execution', () => {
    const report = { verdict: 'preview' as const, runs: [{ status: 'failed' as const }] };
    expect(scenarioReportHeadline(report)).toBe('  ✗ verdict=fail aggregateVerdict=preview (1 run)');
    expect(scenarioExecutionVerdict(report)).toBe('fail');
  });

  it('retains an aggregate failure even if individual run statuses passed', () => {
    const report = { verdict: 'fail' as const, runs: [{ status: 'passed' as const }] };
    expect(scenarioExecutionVerdict(report)).toBe('fail');
    expect(scenarioReportHeadline(report)).toBe('  ✗ verdict=fail (1 run)');
  });
});

describe('llmTestExitCode', () => {
  it('exits 0 when every requested scenario ran and passed', () => {
    expect(llmTestExitCode(['executed', 'executed'])).toBe(LLM_TEST_EXIT_OK);
  });

  it('exits 1 when any scenario failed', () => {
    expect(llmTestExitCode(['executed', 'failed'])).toBe(LLM_TEST_EXIT_FAILED);
  });

  // THE REGRESSION GUARD (EI-22032714687384561). Before the fix, a claim_busy
  // skip returned "not a failure" and the run exited 0 with zero scenarios
  // executed — indistinguishable from a genuine pass, so the natural next
  // action was to record a PASS that nothing had measured. If this assertion
  // is ever relaxed back to LLM_TEST_EXIT_OK, that false green is back.
  it('does NOT exit 0 when every scenario was skipped and nothing executed', () => {
    expect(llmTestExitCode(['skipped'])).toBe(LLM_TEST_EXIT_NOTHING_RAN);
    expect(llmTestExitCode(['skipped', 'skipped'])).toBe(LLM_TEST_EXIT_NOTHING_RAN);
    expect(llmTestExitCode(['skipped'])).not.toBe(LLM_TEST_EXIT_OK);
  });

  // Positive control: the guard above must fire on "nothing ran", NOT merely on
  // "a skip exists". Without this case a guard that reddened on any skip at all
  // would pass the test above while breaking every contended-but-useful run.
  it('exits 0 on a partial skip, because something was actually measured', () => {
    expect(llmTestExitCode(['executed', 'skipped'])).toBe(LLM_TEST_EXIT_OK);
  });

  it('distinguishes nothing-ran from failed, so a caller can tell them apart', () => {
    expect(LLM_TEST_EXIT_NOTHING_RAN).not.toBe(LLM_TEST_EXIT_FAILED);
    expect(LLM_TEST_EXIT_NOTHING_RAN).not.toBe(LLM_TEST_EXIT_OK);
  });

  it('a failure outranks nothing-ran when a runner errored before executing', () => {
    expect(llmTestExitCode(['failed', 'skipped'])).toBe(LLM_TEST_EXIT_FAILED);
  });

  it('treats an empty scenario list as OK (the CLI rejects that earlier, with exit 2)', () => {
    expect(llmTestExitCode([])).toBe(LLM_TEST_EXIT_OK);
  });
});

// PERMANENT FALSIFIABILITY CONTROL.
//
// A guard nobody has seen fail is not a verified guard. Rather than mutate the
// shared tree to prove it (a probe legitimately holds the file broken for as
// long as the suite runs, and git-sync sweeps the WHOLE tree on a schedule —
// so the sweep can commit the mutant even when nothing goes wrong), the
// deliberately-wrong implementation lives here permanently.
//
// `preFixExitCode` is a faithful model of the pre-fix rule in
// apps/operator/bin/llm-test.ts: `runOne` returned false for a claim_busy skip
// ("not a failure — another runner is on it"), `anyFailed` tracked only
// failures, and the process exited `anyFailed ? 1 : 0`. Skips were therefore
// invisible to the exit code.
const preFixExitCode = (outcomes: readonly ScenarioOutcome[]): number =>
  outcomes.some((o) => o === 'failed') ? LLM_TEST_EXIT_FAILED : LLM_TEST_EXIT_OK;

describe('falsifiability control: the pre-fix rule', () => {
  // CALIBRATION — the control must be a faithful model, not merely a different
  // function. On every case that is NOT the bug, it agrees with the real
  // subject; if these drift apart, the control has stopped modelling the old
  // behaviour and the contrast below proves nothing.
  it('agrees with the shipped rule on every case that is not the bug', () => {
    const calibration: ReadonlyArray<readonly ScenarioOutcome[]> = [
      ['executed'],
      ['executed', 'executed'],
      ['executed', 'failed'],
      ['failed'],
    ];
    for (const outcomes of calibration) {
      expect(preFixExitCode(outcomes), `calibration case ${JSON.stringify(outcomes)}`).toBe(
        llmTestExitCode(outcomes),
      );
    }
  });

  // THE CONTRAST — the one input where they must differ. The pre-fix rule
  // reports the all-skipped run as a PASS; that is the bug, reproduced here.
  it('reports the all-skipped run as a pass, which the shipped rule must not', () => {
    expect(preFixExitCode(['skipped'])).toBe(LLM_TEST_EXIT_OK);
    expect(llmTestExitCode(['skipped'])).not.toBe(preFixExitCode(['skipped']));
  });
});

describe('tallyOutcomes / runSummaryLine', () => {
  it('counts each outcome bucket', () => {
    const outcomes: ScenarioOutcome[] = ['executed', 'skipped', 'skipped', 'failed'];
    expect(tallyOutcomes(outcomes)).toEqual({
      requested: 4,
      executed: 1,
      skipped: 2,
      failed: 1,
    });
  });

  it('states the counts so the output is unambiguous even where an exit code is not read', () => {
    expect(runSummaryLine(['skipped'])).toBe('0 executed, 1 skipped, 0 failed, 1 requested');
  });
});
