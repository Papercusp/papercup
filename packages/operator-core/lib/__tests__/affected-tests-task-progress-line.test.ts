/**
 * `scripts/lib/task-progress-line.mjs` — EI-21048499991398082 regression guard.
 *
 * The AFFECTED_TASK_PROGRESS line's `exitStatus=`/`signal=` fields used a bare
 * `value ?? "pending"`. Node's `child.close(code, signal)` pair is mutually exclusive
 * (a normal exit has a numeric `code` and `signal: null`; a signal-kill has `code: null`
 * and a signal name) — so at a TERMINAL progress state ("finished" and friends) exactly
 * one of the two fields is legitimately `null`, meaning "not applicable", not "not yet
 * known". Collapsing that onto the same `"pending"` sentinel used before the task closes
 * made a clean, exit-0 pass — e.g. `state=finished exitStatus=0 signal=pending` — read as
 * still-unresolved, which is the false-red shape the filed bug reports ("aborted run
 * reports exit-0 tasks as FAILED").
 */
import { describe, expect, it } from 'vitest';

import { formatTaskOutcomeFields } from '../../../../scripts/lib/task-progress-line.mjs';

describe('formatTaskOutcomeFields', () => {
  it('renders both fields as "pending" before the task has closed (genuinely unknown)', () => {
    expect(formatTaskOutcomeFields({ status: null, signal: null, settled: false })).toEqual({
      exitStatus: 'pending',
      signal: 'pending',
    });
  });

  // THE REGRESSION CASE: a clean, exit-0 finish must NEVER render `signal=pending` — that is
  // indistinguishable from "still running" and is exactly what sent a release-fixer chasing a
  // phantom regression on a task that had already passed (EI-21048499991398082).
  it('renders a clean exit-0 finish as exitStatus=0 signal=none, never signal=pending', () => {
    const outcome = formatTaskOutcomeFields({ status: 0, signal: null, settled: true });
    expect(outcome).toEqual({ exitStatus: 0, signal: 'none' });
    expect(outcome.signal).not.toBe('pending');
  });

  it('renders a signal-killed finish as exitStatus=none signal=<name>, never exitStatus=pending', () => {
    const outcome = formatTaskOutcomeFields({ status: null, signal: 'SIGTERM', settled: true });
    expect(outcome).toEqual({ exitStatus: 'none', signal: 'SIGTERM' });
    expect(outcome.exitStatus).not.toBe('pending');
  });

  it('renders a non-zero exit-code finish with the real code and signal=none', () => {
    expect(formatTaskOutcomeFields({ status: 1, signal: null, settled: true })).toEqual({
      exitStatus: 1,
      signal: 'none',
    });
  });
});
