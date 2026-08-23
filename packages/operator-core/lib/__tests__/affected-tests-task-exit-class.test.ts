/**
 * `scripts/lib/task-exit-class.mjs` decides whether a finished task's non-zero exit GATES
 * the affected-tests run — and, since EI-20107132436867486, whether it is worth retrying.
 *
 * WHY THIS FILE EXISTS (WI-37830): in-process, every one of these branches runs ONLY after a
 * task has already failed, which on a healthy tree is never. So the logic that protects the
 * gate was reachable by no test and verifiable only by reading it — the same argument
 * batch-watchdog.test.ts and the vitest-summary tests make for their own subjects.
 *
 * The assertions below are deliberately two-sided. A guard that only proves "the forgiven
 * case is forgiven" passes just as happily when the helper forgives EVERYTHING, which would
 * silently disarm the gate for the whole repo — so each forgiving case is paired with the
 * neighbouring case that must still fail.
 */
import { describe, expect, it } from 'vitest';

import { classifyTaskExit, isGatingFailure } from '../../../../scripts/lib/task-exit-class.mjs';

// The caller's mirror (scripts/affected-tests.mjs), passed in as a parameter so this module
// stays import-free — see the module header for why that coupling is deliberate.
const EXIT_NOT_CHECKED = 2;

describe('classifyTaskExit', () => {
  it('classifies a clean exit as a pass', () => {
    expect(classifyTaskExit({ status: 0, notCheckedExitCode: EXIT_NOT_CHECKED })).toBe('pass');
  });

  it('classifies an ordinary non-zero exit as a failure', () => {
    expect(classifyTaskExit({ status: 1, notCheckedExitCode: EXIT_NOT_CHECKED })).toBe('failed');
  });

  it('forgives "I could not look" for a task whose registration opts in', () => {
    expect(
      classifyTaskExit({
        status: EXIT_NOT_CHECKED,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        notCheckedIsNonGating: true,
      }),
    ).toBe('not-checked');
  });

  // THE OVER-BROADNESS GUARD. If this ever returns 'not-checked', the helper has started
  // forgiving exit 2 for every task in the repo rather than only the ones registered as
  // non-gating — a silently disarmed gate, which is far worse than the red it replaced.
  it('does NOT forgive exit 2 for a task that never opted in', () => {
    expect(
      classifyTaskExit({
        status: EXIT_NOT_CHECKED,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        notCheckedIsNonGating: false,
      }),
    ).toBe('failed');
  });

  // The opt-in forgives ONLY the "could not look" code. A registered guard that genuinely
  // found a violation (exit 1) must still red the run.
  it('forgives only the not-checked code, not every non-zero exit, for an opted-in task', () => {
    expect(
      classifyTaskExit({
        status: 1,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        notCheckedIsNonGating: true,
      }),
    ).toBe('failed');
  });

  it('classifies a quarantined failure as quarantined', () => {
    expect(
      classifyTaskExit({ status: 1, notCheckedExitCode: EXIT_NOT_CHECKED, quarantined: true }),
    ).toBe('quarantined');
  });

  // Precedence: "examined nothing" is decided BEFORE quarantine, so the honest explanation
  // wins over the vaguer bucket. This pins the ordering the reporting branch had.
  it('prefers not-checked over quarantined when both apply', () => {
    expect(
      classifyTaskExit({
        status: EXIT_NOT_CHECKED,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        notCheckedIsNonGating: true,
        quarantined: true,
      }),
    ).toBe('not-checked');
  });

  // The code is a parameter, not a constant baked in here: a caller whose mirror said 3
  // must have 3 forgiven and 2 NOT forgiven.
  it('honours the caller-supplied not-checked code rather than assuming 2', () => {
    expect(
      classifyTaskExit({ status: 3, notCheckedExitCode: 3, notCheckedIsNonGating: true }),
    ).toBe('not-checked');
    expect(
      classifyTaskExit({ status: 2, notCheckedExitCode: 3, notCheckedIsNonGating: true }),
    ).toBe('failed');
  });

  it('classifies explicit fork/resource exhaustion output as undetermined', () => {
    expect(
      classifyTaskExit({
        status: 245,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        stderr: '/usr/bin/bash: fork: retry: Resource temporarily unavailable',
      }),
    ).toBe('undetermined');
  });

  it('classifies a short, zero-output death of a long-estimated task as undetermined', () => {
    expect(
      classifyTaskExit({
        status: null,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        capturedBytes: 0,
        elapsedMs: 3_000,
        durationEstimateMs: 22 * 60 * 1_000,
      }),
    ).toBe('undetermined');
  });

  it('does not over-classify short tasks, captured output, or ordinary failures', () => {
    expect(
      classifyTaskExit({
        status: 1,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        capturedBytes: 0,
        elapsedMs: 3_000,
        durationEstimateMs: 9 * 60 * 1_000,
      }),
    ).toBe('failed');
    expect(
      classifyTaskExit({
        status: 1,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        capturedBytes: 1,
        elapsedMs: 3_000,
        durationEstimateMs: 22 * 60 * 1_000,
      }),
    ).toBe('failed');
    expect(
      classifyTaskExit({
        status: 1,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        stderr: 'test assertion failed: expected 1 to be 2',
      }),
    ).toBe('failed');
  });
});

describe('isGatingFailure — the retry decision (EI-20107132436867486)', () => {
  // The bug: the retry branch tested `status !== 0 && !isQuarantined`, so a task the run was
  // about to forgive four branches later was re-run first, printing a WORKSPACE-shaped
  // "<workspace> FAILED — retrying once" for one guard that had examined nothing. On a
  // git-sync-swept tree — the normal state — that fired on every run.
  it('does not count a non-gating "examined nothing" as a failure worth retrying', () => {
    expect(isGatingFailure('not-checked')).toBe(false);
  });

  it('still retries a real failure', () => {
    expect(isGatingFailure('failed')).toBe(true);
  });

  it('does not retry a pass or a quarantined failure', () => {
    expect(isGatingFailure('pass')).toBe(false);
    expect(isGatingFailure('quarantined')).toBe(false);
  });

  it('does not treat an undetermined task as a retryable gating failure', () => {
    expect(isGatingFailure('undetermined')).toBe(false);
  });

  // End-to-end over the two decisions the runner actually makes, in the exact shape that
  // produced the misleading log line: a registered non-gating guard on a clean checkout.
  it('agrees with the reporting branch on the case that produced the bug', () => {
    const cls = classifyTaskExit({
      status: EXIT_NOT_CHECKED,
      notCheckedExitCode: EXIT_NOT_CHECKED,
      notCheckedIsNonGating: true,
      quarantined: false,
    });
    expect(cls).toBe('not-checked');
    // Reported as "examined NOTHING — not gating", and NOT retried. One honest message
    // instead of a scary one plus a pointless re-run.
    expect(isGatingFailure(cls)).toBe(false);
  });
});
