import { describe, expect, it } from 'vitest';
import {
  beginQualificationTransaction,
  checkpointPidIdentity,
  configureRunnerLivenessProber,
  probeRunnerLiveness,
  QUALIFICATION_LAUNCH_GRACE_MS,
  QUALIFICATION_OWNER_ABANDONED_MS,
  reserveQualificationRunner,
  type CheckpointQualificationTransaction,
} from './checkpoint-qualification-transaction';

/**
 * A qualification lease is evidence of INTENT, never of life.
 *
 * Measured 2026-08-30 (EI-21860862169665913 / WI-871887): a manual green-checkpoint run died at
 * 07:29:08Z without settling. Its 3h lease stayed "valid" until 10:05Z, so every scheduled fire in
 * that window returned `conflict` and was skipped. The gate reported `writer-starved` and read as
 * red while in fact rendering NO verdict at all — a state no amount of fixing tests can move.
 *
 * The same incident then exposed the second half: an attempt left non-terminal by a dead owner is
 * also non-RETRYABLE, so `begin` refused every new attempt id, the scheduled routine included.
 *
 * These tests pin BOTH reclaim paths and, just as importantly, pin what must NOT be reclaimed. The
 * dangerous failure here is not a wedge, it is two runners on one candidate — so every 'live' and
 * 'unknown' case below is a real falsifier, not decoration.
 */

const LEASE_MS = 3 * 60 * 60 * 1_000;

const runningWithRunner = (unit: string | null): CheckpointQualificationTransaction => {
  const begun = beginQualificationTransaction(null, {
    attemptId: 'attempt-1',
    candidate: 'candidate-1',
    nowMs: 1_000,
  }).transaction;
  const reserved = reserveQualificationRunner(begun, {
    attemptId: 'attempt-1',
    runnerId: 'manual:attempt-1:1000',
    candidate: 'candidate-1',
    leaseDurationMs: LEASE_MS,
    unit,
    nowMs: 1_000,
  });
  return reserved.transaction;
};

// Well inside the 3h lease: without a liveness term every case below would be a `conflict`.
const DURING_LEASE = 1_000 + 60_000;

it('keeps a not-yet-created named scope single-flight, then recovers its dead reservation', () => {
  const begun = beginQualificationTransaction(null, { attemptId: 'scheduled-attempt', nowMs: 1_000 }).transaction;
  const reserved = reserveQualificationRunner(begun, {
    attemptId: 'scheduled-attempt', runnerId: 'fire-1', unit: 'papercusp-checkpoint-fire-1.scope',
    leaseDurationMs: LEASE_MS, started: false, nowMs: 1_000,
  }).transaction;
  const runner = reserved.currentPhysicalRunner!;
  configureRunnerLivenessProber(() => 'dead');
  try {
    const duringLaunch = 1_000 + QUALIFICATION_LAUNCH_GRACE_MS - 1;
    expect(probeRunnerLiveness(runner, duringLaunch)).toBe('unknown');
    expect(reserveQualificationRunner(reserved, {
      attemptId: 'scheduled-attempt', runnerId: 'fire-2', leaseDurationMs: LEASE_MS,
      incumbentLiveness: 'dead', nowMs: duringLaunch,
    }).status).toBe('conflict');
    expect(beginQualificationTransaction(reserved, {
      attemptId: 'successor-attempt', incumbentLiveness: 'dead', nowMs: duringLaunch,
    }).status).toBe('conflict');

    const afterLaunch = 1_000 + QUALIFICATION_LAUNCH_GRACE_MS;
    expect(probeRunnerLiveness(runner, afterLaunch)).toBe('dead');
    const reclaimed = reserveQualificationRunner(reserved, {
      attemptId: 'scheduled-attempt', runnerId: 'fire-2', leaseDurationMs: LEASE_MS,
      incumbentLiveness: 'dead', nowMs: afterLaunch,
    });
    expect(reclaimed.status).toBe('updated');
    expect(reclaimed.transaction.consumedPhysicalRuns?.at(-1)?.outcome).toEqual({
      kind: 'pre-suite-no-verdict', reason: 'runner-vanished',
    });
  } finally {
    configureRunnerLivenessProber(null);
  }
});

it('proves a scheduled CLI runner by PID boot/start identity, including recycled and unknown cases', () => {
  configureRunnerLivenessProber(null);
  const identity = checkpointPidIdentity(process.pid);
  expect(identity).toMatch(/^[0-9a-f-]+:\d+$/);
  const current = runningWithRunner(null).currentPhysicalRunner!;
  const runner = { ...current, pid: process.pid, pidIdentity: identity };
  expect(probeRunnerLiveness(runner)).toBe('live');
  expect(probeRunnerLiveness({ ...runner, pidIdentity: `${identity}-recycled` })).toBe('dead');
  expect(probeRunnerLiveness({ ...runner, pidIdentity: null })).toBe('unknown');
});

describe('reserveQualificationRunner — a lease is not proof of life', () => {
  it('RECLAIMS a lease whose runner was proved dead, even though the lease has hours left', () => {
    const current = runningWithRunner('papercup-green-checkpoint-manual-1fxzuva.service');
    expect(current.currentPhysicalRunner?.leaseExpiresAtMs).toBeGreaterThan(DURING_LEASE);

    const result = reserveQualificationRunner(current, {
      attemptId: 'attempt-1',
      runnerId: 'manual:attempt-1:2000',
      leaseDurationMs: LEASE_MS,
      incumbentLiveness: 'dead',
      nowMs: DURING_LEASE,
    });

    expect(result.status).toBe('updated');
    expect(result.transaction.currentPhysicalRunner?.id).toBe('manual:attempt-1:2000');
  });

  it('records the displaced runner as runner-vanished, NOT as a runner that merely overran', () => {
    const current = runningWithRunner('unit.service');
    const result = reserveQualificationRunner(current, {
      attemptId: 'attempt-1',
      runnerId: 'manual:attempt-1:2000',
      leaseDurationMs: LEASE_MS,
      incumbentLiveness: 'dead',
      nowMs: DURING_LEASE,
    });

    const displaced = result.transaction.consumedPhysicalRuns?.at(-1);
    expect(displaced?.id).toBe('manual:attempt-1:1000');
    expect(displaced?.outcome).toEqual({ kind: 'pre-suite-no-verdict', reason: 'runner-vanished' });
  });

  // The falsifiers. If these ever pass as 'updated', the reaper is handing one candidate to two
  // concurrent runners, which is strictly worse than the wedge it replaced.
  it('REFUSES to displace a runner that is alive', () => {
    const current = runningWithRunner('unit.service');
    expect(reserveQualificationRunner(current, {
      attemptId: 'attempt-1',
      runnerId: 'manual:attempt-1:2000',
      leaseDurationMs: LEASE_MS,
      incumbentLiveness: 'live',
      nowMs: DURING_LEASE,
    }).status).toBe('conflict');
  });

  it('REFUSES to displace a runner whose liveness is unknown (fails closed to the old behaviour)', () => {
    const current = runningWithRunner(null);
    expect(reserveQualificationRunner(current, {
      attemptId: 'attempt-1',
      runnerId: 'manual:attempt-1:2000',
      leaseDurationMs: LEASE_MS,
      incumbentLiveness: 'unknown',
      nowMs: DURING_LEASE,
    }).status).toBe('conflict');

    // Omitting the field entirely must be identical to 'unknown' — that is what makes every
    // pre-existing caller safe without being updated.
    expect(reserveQualificationRunner(current, {
      attemptId: 'attempt-1',
      runnerId: 'manual:attempt-1:2000',
      leaseDurationMs: LEASE_MS,
      nowMs: DURING_LEASE,
    }).status).toBe('conflict');
  });

  it('does not treat an expired lease as proof that an unknown runner is dead', () => {
    const current = runningWithRunner('unit.service');
    expect(reserveQualificationRunner(current, {
      attemptId: 'attempt-1',
      runnerId: 'manual:attempt-1:2000',
      leaseDurationMs: LEASE_MS,
      incumbentLiveness: 'unknown',
      nowMs: 1_000 + LEASE_MS + 1,
    }).status).toBe('conflict');
  });
});

describe('beginQualificationTransaction — an owner that died must not hold the singleton forever', () => {
  it('lets a NEW attempt take over when the incumbent runner is proved dead', () => {
    const current = runningWithRunner('unit.service');
    const result = beginQualificationTransaction(current, {
      attemptId: 'attempt-2',
      incumbentLiveness: 'dead',
      nowMs: DURING_LEASE,
    });

    expect(result.status).toBe('updated');
    expect(result.transaction.attemptId).toBe('attempt-2');
    expect(result.transaction.previousAttemptId).toBe('attempt-1');
  });

  it('REFUSES a takeover while the incumbent runner is alive or unproven', () => {
    const current = runningWithRunner('unit.service');
    expect(beginQualificationTransaction(current, {
      attemptId: 'attempt-2',
      incumbentLiveness: 'live',
      nowMs: DURING_LEASE,
    }).status).toBe('conflict');
    expect(beginQualificationTransaction(current, {
      attemptId: 'attempt-2',
      nowMs: DURING_LEASE,
    }).status).toBe('conflict');
  });

  it('reclaims a runnerless attempt only after no owner could still legally be alive', () => {
    // This is the shape that wedged the gate on 2026-08-30: phase `waiting`, no runner, and a
    // pre-suite reason that is neither terminal nor in the single retryable-wait allowlist.
    const stranded: CheckpointQualificationTransaction = {
      ...runningWithRunner('unit.service'),
      phase: 'waiting',
      outcome: { kind: 'pre-suite-no-verdict', reason: 'source-mutated' },
      currentPhysicalRunner: null,
      updatedAtMs: 1_000,
    };

    // Just inside the window an owner could still be working; the claim stands.
    expect(beginQualificationTransaction(stranded, {
      attemptId: 'attempt-2',
      nowMs: 1_000 + QUALIFICATION_OWNER_ABANDONED_MS,
    }).status).toBe('conflict');

    // Past it, no runner can legally still be alive, so nobody is coming to advance it.
    expect(beginQualificationTransaction(stranded, {
      attemptId: 'attempt-2',
      nowMs: 1_000 + QUALIFICATION_OWNER_ABANDONED_MS + 1,
    }).status).toBe('updated');
  });

  it('never reclaims a TERMINAL attempt through the abandoned path', () => {
    const settled: CheckpointQualificationTransaction = {
      ...runningWithRunner('unit.service'),
      phase: 'terminal',
      outcome: { kind: 'green', reason: 'advanced' },
      currentPhysicalRunner: null,
      updatedAtMs: 1_000,
    };
    // A terminal attempt is legitimately superseded, but via the terminal path, not the reaper —
    // begin() must still hand back a fresh attempt rather than report a conflict.
    const result = beginQualificationTransaction(settled, {
      attemptId: 'attempt-2',
      nowMs: 1_000 + QUALIFICATION_OWNER_ABANDONED_MS + 1,
    });
    expect(result.status).toBe('updated');
    expect(result.transaction.attemptId).toBe('attempt-2');
  });
});
