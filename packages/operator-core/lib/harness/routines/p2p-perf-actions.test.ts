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
import { describe, it, expect } from 'vitest';
import { classifyNoSummaryRun } from './p2p-perf-actions';

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
