/**
 * p2p-perf-actions.test.ts — regression guard for EI-5753.
 *
 * THE BUG: when a nightly Tier-1 run produced no summary, runTier auto-filed a
 * `kind:'bug'` improvement for EVERY exit — including a SIGNAL-terminated run
 * (exit 143=SIGTERM / 137=SIGKILL, or a non-null close signal). A signal-kill is
 * an INTERRUPTED run — the run's own 30-min timeout firing, the OOM killer, or a
 * bg-host service restart mid-run — not a runner crash with a real finding. Because
 * `kind:'bug'` is auto-implement-eligible, "the box was restarted" got routed into
 * the auto-fix loop and re-filed nightly (this very EI).
 *
 * classifyNoSummaryRun is the pure policy: only a genuine non-zero crash is a bug;
 * a timeout is a human-reviewed perf signal; an external signal-kill is not a
 * finding at all. This locks that classification so the noise loop can't return.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyNoSummaryRun } from './p2p-perf-actions';
import type { RunSummary } from '../../sync/hyperbee/perf/runner';

const captureImprovementMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../improvements/capture-core', () => ({
  captureImprovement: (...args: unknown[]) => captureImprovementMock(...args),
}));

// EI-7254: the exact-lookup pre-filter — defaults to "nothing already open" so
// the pre-existing watchdogKey-stability tests below are unaffected; individual
// tests override this to simulate an already-open standing issue.
const findIssuesByWatchdogKeysMock = vi.fn().mockResolvedValue([]);
vi.mock('../../issues-engineer', () => ({
  findIssuesByWatchdogKeys: (...args: unknown[]) => findIssuesByWatchdogKeysMock(...args),
}));

describe('classifyNoSummaryRun (EI-5753)', () => {
  it('classifies our own timeout firing as a timeout (human-reviewed perf signal, not a bug)', () => {
    // The killer fired and SIGTERM'd the tree; the tsx wrapper forwarded exit 143.
    expect(classifyNoSummaryRun({ code: 143, signal: null, timedOut: true })).toBe('timeout');
    // …or Node reported the signal directly on the tsx child.
    expect(classifyNoSummaryRun({ code: 1, signal: 'SIGTERM', timedOut: true })).toBe('timeout');
  });

  it('classifies an external SIGTERM (exit 143) with NO timeout as an interrupted signal-kill — not a finding', () => {
    // bg-host service restart / cgroup SIGTERM mid-run: our killer never fired.
    // This was the EI-5753 case mis-filed as kind:'bug'.
    expect(classifyNoSummaryRun({ code: 143, signal: null, timedOut: false })).toBe('signal');
  });

  it('classifies a SIGKILL (exit 137, e.g. OOM) with NO timeout as an interrupted signal-kill', () => {
    expect(classifyNoSummaryRun({ code: 137, signal: null, timedOut: false })).toBe('signal');
  });

  it('classifies ANY forwarded signal-band exit (128+N) with NO timeout as a signal-kill, not a crash bug (EI-5752 class)', () => {
    // The runner only ever exits 0/1, so an exit code in 129..159 is the tsx wrapper
    // forwarding a signal-kill it could not surface as a `close` signal — SIGHUP(129),
    // SIGINT(130), SIGABRT(134), SIGSEGV(139). Each must NOT re-file as an auto-fix bug.
    for (const code of [129, 130, 134, 139, 159]) {
      expect(classifyNoSummaryRun({ code, signal: null, timedOut: false })).toBe('signal');
    }
  });

  it('does NOT treat ordinary error exits (1/2/127/128) as signal-kills — those stay crashes', () => {
    // The boundary: a missing-runner 127 or a generic 1/2 is a genuine defect (bug),
    // and 128 (no signal byte) is below the 128+N band.
    for (const code of [1, 2, 127, 128]) {
      expect(classifyNoSummaryRun({ code, signal: null, timedOut: false })).toBe('crash');
    }
  });

  it('classifies a non-null close signal as a signal-kill regardless of code', () => {
    expect(classifyNoSummaryRun({ code: 1, signal: 'SIGKILL', timedOut: false })).toBe('signal');
    expect(classifyNoSummaryRun({ code: 0, signal: 'SIGTERM', timedOut: false })).toBe('signal');
  });

  it('classifies a genuine non-zero crash (no signal, no timeout) as a real bug', () => {
    // The runner actually threw / exited non-zero — an auto-fixable defect.
    expect(classifyNoSummaryRun({ code: 1, signal: null, timedOut: false })).toBe('crash');
    expect(classifyNoSummaryRun({ code: 2, signal: null, timedOut: false })).toBe('crash');
    expect(classifyNoSummaryRun({ code: 127, signal: null, timedOut: false })).toBe('crash');
  });

  it('treats a timeout as a timeout even though the kill also yields a signal/143 (timeout wins)', () => {
    // Our timeout firing implies we SIGTERM'd the tree, so signal/143 co-occur —
    // the run overran its budget, so it must classify as timeout, not signal.
    expect(classifyNoSummaryRun({ code: 143, signal: 'SIGTERM', timedOut: true })).toBe('timeout');
  });
});

describe('fileFindings watchdogKey stability (EI-3909/EI-5846/EI-5829/EI-6585)', () => {
  beforeEach(() => {
    captureImprovementMock.mockClear();
    findIssuesByWatchdogKeysMock.mockClear();
    findIssuesByWatchdogKeysMock.mockResolvedValue([]);
  });

  function summaryWith(overrides: Partial<RunSummary>): RunSummary {
    return {
      runId: 'r1',
      profile: 'ci',
      outDir: '/tmp/out',
      reportPath: '/tmp/out/report.md',
      scenarioFailures: [],
      sloViolations: [],
      regressions: [],
      artifacts: [],
      baselineCompared: true,
      ...overrides,
    } as RunSummary;
  }

  it('stamps a watchdogKey for a regression that does NOT vary run-to-run even though baseline/current/relChange do', async () => {
    const { fileFindings } = (
      await import('./p2p-perf-actions')
    )._testing;

    // Two "different nights" of the SAME regressed metric — every live number differs,
    // but scenario/paramsKey/metric (what the watchdogKey must key on) stay identical.
    await fileFindings(
      summaryWith({
        regressions: [
          { scenario: 'merge.delta-tick', paramsKey: 'historySize=1000,seed=1234', metric: 'deltaTick1000Ms', baseline: 146.982, current: 1068.699, relChange: 6.27 },
        ],
      }),
      'nightly Tier-1',
    );
    await fileFindings(
      summaryWith({
        regressions: [
          { scenario: 'merge.delta-tick', paramsKey: 'historySize=1000,seed=1234', metric: 'deltaTick1000Ms', baseline: 146.982, current: 1186.973, relChange: 7.08 },
        ],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(2);
    const firstKey = captureImprovementMock.mock.calls[0]![0].watchdogKey;
    const secondKey = captureImprovementMock.mock.calls[1]![0].watchdogKey;
    expect(firstKey).toBe('p2p-perf-regression:merge.delta-tick:historySize=1000,seed=1234:deltaTick1000Ms');
    // THE regression this test guards: same key across runs despite different live numbers.
    expect(firstKey).toBe(secondKey);
    // And the title (which DOES embed the live numbers) legitimately differs —
    // the watchdogKey, not the title, is what must carry cross-run identity.
    expect(captureImprovementMock.mock.calls[0]![0].title).not.toBe(captureImprovementMock.mock.calls[1]![0].title);
  });

  it('stamps a watchdogKey for an SLO violation keyed on scenario+params only (not the live p95Ms)', async () => {
    const { fileFindings } = (
      await import('./p2p-perf-actions')
    )._testing;

    await fileFindings(
      summaryWith({
        sloViolations: [{ scenario: 'churn.reconnect-storm', paramsKey: 'historySize=10000,readers=4,seed=1234,winners=3710', p95Ms: 812, limitMs: 500 }],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
    expect(captureImprovementMock.mock.calls[0]![0].watchdogKey).toBe(
      'p2p-perf-slo:churn.reconnect-storm:historySize=10000,readers=4,seed=1234,winners=3710',
    );
  });

  it('gives a DIFFERENT watchdogKey to a different metric on the SAME scenario/params (they must not dedup against each other)', async () => {
    const { fileFindings } = (
      await import('./p2p-perf-actions')
    )._testing;

    await fileFindings(
      summaryWith({
        regressions: [
          { scenario: 'merge.delta-tick', paramsKey: 'historySize=1000,seed=1234', metric: 'deltaTick100Ms', baseline: 13.857, current: 74.832, relChange: 4.4 },
          { scenario: 'merge.delta-tick', paramsKey: 'historySize=1000,seed=1234', metric: 'deltaTick1000Ms', baseline: 146.982, current: 874.11, relChange: 4.95 },
        ],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(2);
    const keys = captureImprovementMock.mock.calls.map((c) => c[0].watchdogKey);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('fileFindings exact watchdogKey pre-filter (EI-7254)', () => {
  beforeEach(() => {
    captureImprovementMock.mockClear();
    findIssuesByWatchdogKeysMock.mockClear();
  });

  function summaryWith(overrides: Partial<RunSummary>): RunSummary {
    return {
      runId: 'r1',
      profile: 'ci',
      outDir: '/tmp/out',
      reportPath: '/tmp/out/report.md',
      scenarioFailures: [],
      sloViolations: [],
      regressions: [],
      artifacts: [],
      baselineCompared: true,
      ...overrides,
    } as RunSummary;
  }

  it('SKIPS capture entirely when an OPEN issue already carries the exact watchdogKey — even though capture-core\'s own fuzzy search-first dedup is mocked away and would have let it through', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;
    const key = 'p2p-perf-regression:merge.delta-tick:historySize=1000,seed=1234:deltaTick100Ms';
    findIssuesByWatchdogKeysMock.mockResolvedValue([
      { id: 'EI-1', state: 'open', payload: { watchdogKey: key }, updatedAt: new Date().toISOString() },
    ]);

    await fileFindings(
      summaryWith({
        regressions: [
          { scenario: 'merge.delta-tick', paramsKey: 'historySize=1000,seed=1234', metric: 'deltaTick100Ms', baseline: 13.857, current: 90.492, relChange: 5.53 },
        ],
      }),
      'nightly Tier-1',
    );

    expect(findIssuesByWatchdogKeysMock).toHaveBeenCalledWith([key]);
    expect(captureImprovementMock).not.toHaveBeenCalled();
  });

  it('does NOT skip when the existing issue with the same key is already RESOLVED (not open)', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;
    const key = 'p2p-perf-slo:churn.reconnect-storm:historySize=10000,readers=4,seed=1234,winners=3710';
    findIssuesByWatchdogKeysMock.mockResolvedValue([
      { id: 'EI-2', state: 'resolved', payload: { watchdogKey: key }, updatedAt: new Date().toISOString() },
    ]);

    await fileFindings(
      summaryWith({
        sloViolations: [{ scenario: 'churn.reconnect-storm', paramsKey: 'historySize=10000,readers=4,seed=1234,winners=3710', p95Ms: 812, limitMs: 500 }],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
  });

  it('a lookup failure (e.g. no DB) never blocks filing — fails open, same as before the fix', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;
    findIssuesByWatchdogKeysMock.mockRejectedValue(new Error('no db in this test'));

    await fileFindings(
      summaryWith({
        regressions: [
          { scenario: 'merge.delta-tick', paramsKey: 'historySize=1000,seed=1234', metric: 'deltaTick100Ms', baseline: 13.857, current: 90.492, relChange: 5.53 },
        ],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
  });

  it('files an advisory regression as kind:"change" (human-reviewed), not kind:"bug" (auto-implement-eligible) — EI-7254', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;

    await fileFindings(
      summaryWith({
        regressions: [
          { scenario: 'merge.delta-tick', paramsKey: 'historySize=1000,seed=1234', metric: 'deltaTick100Ms', baseline: 13.857, current: 90.492, relChange: 5.53 },
        ],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
    expect(captureImprovementMock.mock.calls[0]![0].kind).toBe('change');
  });

  it('still files an SLO violation as kind:"bug" (a real regression worth an auto-fix attempt)', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;

    await fileFindings(
      summaryWith({
        sloViolations: [{ scenario: 'churn.reconnect-storm', paramsKey: 'historySize=10000,readers=4,seed=1234,winners=3710', p95Ms: 812, limitMs: 500 }],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
    expect(captureImprovementMock.mock.calls[0]![0].kind).toBe('bug');
  });
});
