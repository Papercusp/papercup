import { describe, expect, it } from 'vitest';
import {
  assessTerminalRepairQueueReconciliation,
  beginQualificationTransaction,
  classifyScheduledQualificationJoin,
  cancelQualificationTransaction,
  classifyQualificationVerdict,
  describeQualificationSettleConflict,
  parseCheckpointQualificationTransaction,
  projectCheckpointQualificationState,
  QUALIFICATION_PROGRESS_STALE_MS,
  recordQualificationRunnerProgress,
  recordQualificationScheduledFire,
  qualificationIntentMatches,
  reserveQualificationRunner,
  recoverQualificationScheduledTerminal,
  settleQualificationTransaction,
  waitQualificationTransaction,
} from './checkpoint-qualification-transaction';
import {
  createFrozenCandidateQueue,
  markFrozenCandidateVerificationRed,
  markFrozenRepairAdmitted,
} from './frozen-candidate-repair-queue';
import {
  CHECKPOINT_ELIGIBILITY_PREDICATES,
  buildCheckpointEligibilitySnapshot,
} from './checkpoint-eligibility-snapshot';

const begin = () =>
  beginQualificationTransaction(null, {
    attemptId: 'attempt-1',
    requiredAncestorSha: 'abc123',
    declaredPaths: ['b.ts', 'a.ts', 'a.ts'],
    candidate: 'candidate-1',
    evidenceRefs: ['tool:release:checkpoint-run'],
    nowMs: 100,
  }).transaction;

describe('logical checkpoint qualification transaction', () => {
  it('keeps scheduler fires separate from suite progress and a terminal verdict', () => {
    const ready = begin();
    const scheduled = recordQualificationScheduledFire(ready, 200);
    expect(scheduled).toMatchObject({ status: 'updated', transaction: { lastScheduledAtMs: 200, updatedAtMs: 100 } });
    const joined = recordQualificationScheduledFire(scheduled.transaction, 300);
    expect(joined).toMatchObject({ status: 'updated', transaction: { lastScheduledAtMs: 300, updatedAtMs: 100 } });
    expect(projectCheckpointQualificationState(joined.transaction, 400).agesMs).toEqual({
      attempt: 300,
      scheduled: 100,
      started: null,
      progress: null,
      terminal: null,
    });

    const running = reserveQualificationRunner(joined.transaction, {
      attemptId: 'attempt-1', runnerId: 'runner-1', candidate: 'candidate-1',
      leaseDurationMs: 1_000, nowMs: 500,
    }).transaction;
    const fireDuringRun = recordQualificationScheduledFire(running, 600).transaction;
    expect(projectCheckpointQualificationState(fireDuringRun, 700).agesMs).toMatchObject({
      scheduled: 100, started: 200, progress: 200, terminal: null,
    });
    const terminal = settleQualificationTransaction(fireDuringRun, {
      attemptId: 'attempt-1', candidate: 'candidate-1', reason: 'not-green', green: false, nowMs: 800,
    }).transaction;
    expect(projectCheckpointQualificationState(terminal, 900).agesMs).toMatchObject({
      scheduled: 300, started: 400, progress: 400, terminal: 100,
    });
    expect(recordQualificationScheduledFire(terminal, 1_000).status).toBe('terminal');
  });
  it('joins a live physical runner even past its lease and fails closed on unknown liveness', () => {
    const ready = begin();
    expect(classifyScheduledQualificationJoin(ready, 'unknown')).toBe('launch');
    const running = reserveQualificationRunner(ready, {
      attemptId: 'attempt-1', runnerId: 'runner-1', candidate: 'candidate-1',
      leaseDurationMs: 1, nowMs: 200,
    }).transaction;
    expect(classifyScheduledQualificationJoin(running, 'live')).toBe('join');
    expect(classifyScheduledQualificationJoin(running, 'unknown')).toBe('unknown-liveness');
    expect(classifyScheduledQualificationJoin(running, 'dead')).toBe('launch');
  });
  it('only accepts progress from the exact activated runner and keeps scheduler time independent', () => {
    const reserved = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'fire-1', leaseDurationMs: 1_000_000,
      started: false, nowMs: 200,
    }).transaction;
    const running = reserveQualificationRunner(reserved, {
      attemptId: 'attempt-1', runnerId: 'fire-1', runId: 'run-1',
      pid: 123, pidIdentity: 'boot:1', leaseDurationMs: 1_000_000,
      started: true, nowMs: 300,
    }).transaction;
    const scheduled = recordQualificationScheduledFire(running, 400).transaction;
    expect(scheduled.lastProgressAtMs).toBe(300);
    const input = { attemptId: 'attempt-1', runnerId: 'fire-1', runId: 'run-1', pidIdentity: 'boot:1', phase: 'suite' as const, nowMs: 500 };
    expect(recordQualificationRunnerProgress(scheduled, { ...input, runnerId: 'fire-2' }).status).toBe('conflict');
    expect(recordQualificationRunnerProgress(scheduled, { ...input, pidIdentity: 'boot:2' }).status).toBe('conflict');
    const progress = recordQualificationRunnerProgress(scheduled, input);
    expect(progress).toMatchObject({ status: 'updated', transaction: {
      lastScheduledAtMs: 400, lastProgressAtMs: 500,
      currentPhysicalRunner: { heartbeatAtMs: 500, phase: 'suite', leaseExpiresAtMs: 1_000_300 },
    } });
    expect(projectCheckpointQualificationState(progress.transaction, 550, 'live')).toMatchObject({
      lease: { holder: 'fire-1', acquiredAtMs: 200, expiresAtMs: 1_000_300, expired: false },
      runnerHealth: { state: 'progressing', liveness: 'live', phase: 'suite', progressAgeMs: 50 },
      clocks: { lastScheduledAtMs: 400, lastStartedAtMs: 300, lastProgressAtMs: 500, lastTerminalVerdictAtMs: null },
      agesMs: { scheduled: 150, started: 250, progress: 50, terminal: null },
    });
    const staleAt = 500 + QUALIFICATION_PROGRESS_STALE_MS + 1;
    const anotherFire = recordQualificationScheduledFire(progress.transaction, staleAt).transaction;
    expect(projectCheckpointQualificationState(anotherFire, staleAt, 'live')).toMatchObject({
      runnerHealth: { state: 'stalled', liveness: 'live', phase: 'suite' },
      agesMs: { scheduled: 0, progress: QUALIFICATION_PROGRESS_STALE_MS + 1 },
      safeNextAction: { code: 'inspect-runner-liveness' },
    });
    expect(recordQualificationRunnerProgress(progress.transaction, { ...input, nowMs: 450 }).status).toBe('idempotent');
    const terminal = settleQualificationTransaction(progress.transaction, {
      attemptId: 'attempt-1', runId: 'run-1', reason: 'not-green', green: false, nowMs: 600,
    }).transaction;
    expect(recordQualificationRunnerProgress(terminal, { ...input, nowMs: 700 }).status).toBe('terminal');
    expect(settleQualificationTransaction(terminal, {
      attemptId: 'attempt-1', runId: 'run-other', reason: 'advanced', green: true, nowMs: 700,
    }).status).toBe('conflict');
    expect(settleQualificationTransaction(terminal, {
      attemptId: 'attempt-1', runId: 'run-1', reason: 'not-green', green: false, nowMs: 700,
    }).status).toBe('terminal');
  });
  it('projects owner, phase, heartbeat, and deadline from the persisted runner fields', () => {
    const running = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'runner-1', runId: 'run-1', candidate: 'candidate-1',
      pid: 123, pidIdentity: 'boot:1', leaseDurationMs: 1_000, started: true, nowMs: 200,
    }).transaction;
    const runner = running.currentPhysicalRunner!;
    const project = (changes: Partial<typeof runner>) =>
      projectCheckpointQualificationState({ ...running, currentPhysicalRunner: { ...runner, ...changes } }, 300, 'live');

    expect(project({})).toMatchObject({
      lease: { holder: 'runner-1', expiresAtMs: 1_200, expired: false },
      runnerHealth: { phase: 'materializing', progressAgeMs: 100 },
    });
    expect(project({ id: 'runner-2' }).lease?.holder).toBe('runner-2');
    expect(project({ phase: 'suite' }).runnerHealth.phase).toBe('suite');
    expect(project({ heartbeatAtMs: 250 }).runnerHealth.progressAgeMs).toBe(50);
    expect(project({ leaseExpiresAtMs: 250 })).toMatchObject({
      lease: { expired: true }, safeNextAction: { code: 'inspect-runner-liveness' },
    });
  });
  it('creates one normalized durable identity and reuses the same attempt idempotently', () => {
    const current = begin();
    expect(current).toMatchObject({
      attemptId: 'attempt-1',
      phase: 'ready',
      outcome: { kind: 'pending' },
      candidatePolicy: { kind: 'quiet-cut', declaredPaths: ['b.ts', 'a.ts'] },
      waitGeneration: 0,
    });
    expect(beginQualificationTransaction(current, { attemptId: 'attempt-1', nowMs: 200 }).status).toBe('idempotent');
    expect(beginQualificationTransaction(current, { attemptId: 'attempt-2', nowMs: 200 }).status).toBe('conflict');
    expect(
      qualificationIntentMatches(current, {
        requiredAncestorSha: 'abc123',
        declaredPaths: ['a.ts', 'b.ts'],
      }),
    ).toBe(true);
    expect(
      qualificationIntentMatches(current, {
        requiredAncestorSha: 'different',
        declaredPaths: ['a.ts', 'b.ts'],
      }),
    ).toBe(false);
  });

  it('pins the first terminal result to the exact candidate and run identity', () => {
    const current = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      candidate: 'candidate-1',
      leaseDurationMs: 1_000,
      nowMs: 150,
    }).transaction;

    const staleCandidate = settleQualificationTransaction(current, {
      attemptId: 'attempt-1',
      candidate: 'candidate-2',
      runId: 'run-1',
      reason: 'not-green',
      green: false,
      nowMs: 200,
    });
    expect(staleCandidate).toMatchObject({ status: 'conflict', transaction: current });

    const first = settleQualificationTransaction(current, {
      attemptId: 'attempt-1',
      candidate: 'candidate-1',
      runId: 'run-1',
      reason: 'not-green',
      green: false,
      nowMs: 200,
    });
    expect(first).toMatchObject({
      status: 'updated',
      transaction: { candidate: 'candidate-1', runId: 'run-1', phase: 'terminal' },
    });

    const duplicateFromOtherRun = settleQualificationTransaction(first.transaction, {
      attemptId: 'attempt-1',
      candidate: 'candidate-1',
      runId: 'run-2',
      reason: 'advanced',
      green: true,
      nowMs: 300,
    });
    expect(duplicateFromOtherRun).toMatchObject({ status: 'conflict', transaction: first.transaction });
    expect(settleQualificationTransaction(first.transaction, {
      attemptId: 'attempt-1', candidate: 'candidate-1', runId: 'run-1',
      reason: 'advanced', green: true, nowMs: 300,
    }).status).toBe('conflict');
  });

  it('recovers a mismatched pre-suite terminal only for its exact unitless scheduled runner, including replay', () => {
    const reserved = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'fire-1', candidate: 'candidate-1',
      evidenceRefs: ['gate-fire:fire-1'], leaseDurationMs: 1_000, started: false, nowMs: 150,
    }).transaction;
    const proof = {
      attemptId: 'attempt-1', runnerId: 'fire-1', runId: 'wrapper-1',
      reason: 'skipped-locked', finishedAtMs: 200,
      evidenceRefs: ['checkpoint-terminal:wrapper-1', 'gate-fire:fire-1'], nowMs: 210,
    };
    expect(settleQualificationTransaction(reserved, {
      attemptId: 'attempt-1', reason: 'skipped-locked', candidate: 'candidate-2', nowMs: 200,
    }).status).toBe('conflict');
    for (const changed of [
      { runnerId: 'fire-other' }, { attemptId: 'attempt-other' }, { reason: 'not-green' },
      { finishedAtMs: 149 }, { evidenceRefs: ['gate-fire:fire-1'] },
    ]) {
      expect(recoverQualificationScheduledTerminal(reserved, { ...proof, ...changed }).status).toBe('conflict');
    }
    expect(recoverQualificationScheduledTerminal({
      ...reserved, currentPhysicalRunner: { ...reserved.currentPhysicalRunner!, pid: 123 },
    }, proof).status).toBe('conflict');
    const recovered = recoverQualificationScheduledTerminal(reserved, proof);
    expect(recovered).toMatchObject({
      status: 'updated', transaction: {
        phase: 'terminal', candidate: 'candidate-1', currentPhysicalRunner: null,
        outcome: { kind: 'code-inconclusive', reason: 'orphaned-reservation-after-skipped-locked' },
      },
    });
    expect(recovered.transaction.consumedPhysicalRuns).toHaveLength(1);
    expect(recoverQualificationScheduledTerminal(recovered.transaction, proof).status).toBe('terminal');
    expect(recoverQualificationScheduledTerminal(recovered.transaction, { ...proof, runId: 'other' }).status).toBe('conflict');
  });

  it('WI-10002454: names every identity behind a settle conflict, and nothing when identities agree', () => {
    const reserved = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      candidate: 'candidate-1',
      leaseDurationMs: 1_000,
      nowMs: 150,
    }).transaction;
    const stored = { ...reserved, runId: 'run-1' };
    const verdict = { reason: 'not-green', green: false, nowMs: 200 };
    const cases = [
      { produced: { attemptId: 'attempt-2', candidate: 'candidate-1', runId: 'run-1' }, expected: ['attempt stored=attempt-1 produced=attempt-2'] },
      { produced: { attemptId: 'attempt-1', candidate: 'candidate-2', runId: 'run-1' }, expected: ['candidate stored=candidate-1 produced=candidate-2'] },
      { produced: { attemptId: 'attempt-1', candidate: 'candidate-1', runId: 'run-2' }, expected: ['run stored=run-1 produced=run-2'] },
    ];
    for (const { produced, expected } of cases) {
      // Calibration: the REAL settle must call each of these a conflict, or the helper would be
      // describing a disagreement the state machine does not have.
      expect(settleQualificationTransaction(stored, { ...produced, ...verdict }).status).toBe('conflict');
      expect(describeQualificationSettleConflict(stored, produced)).toEqual(expected);
    }
    // Every mismatch is named, not only the first one the settle short-circuits on.
    expect(
      describeQualificationSettleConflict(stored, { attemptId: 'attempt-2', candidate: 'candidate-2', runId: 'run-2' }),
    ).toHaveLength(3);
    // Agreeing (trimmed) or absent produced identities yield [] — the CAS-race signal, never a
    // fabricated mismatch.
    const agreeing = { attemptId: 'attempt-1', candidate: ' candidate-1 ', runId: null };
    expect(settleQualificationTransaction(stored, { ...agreeing, ...verdict }).status).not.toBe('conflict');
    expect(describeQualificationSettleConflict(stored, agreeing)).toEqual([]);
  });

  it('releases the singleton when an eligibility waiter never started, while preserving real waits', () => {
    const unavailable = waitQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'wait-for-eligibility-unavailable',
      blockers: [
        {
          code: 'dbos-eligibility-waiter',
          detail: 'DBOS is not installed',
          clearEvents: [],
        },
      ],
      nowMs: 200,
    }).transaction;

    const sameAttempt = beginQualificationTransaction(unavailable, {
      attemptId: 'attempt-1',
      requiredAncestorSha: 'abc123',
      declaredPaths: ['a.ts', 'b.ts'],
      candidate: 'candidate-1',
      evidenceRefs: ['tool:release:checkpoint-run'],
      nowMs: 300,
    });
    expect(sameAttempt).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-1',
        phase: 'ready',
        outcome: { kind: 'pending' },
        blockers: [],
        phaseDurationsMs: { ready: 100, waiting: 100 },
      },
    });

    const successor = beginQualificationTransaction(unavailable, {
      attemptId: 'attempt-2',
      candidate: 'candidate-2',
      nowMs: 300,
    });
    expect(successor).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-2',
        previousAttemptId: 'attempt-1',
        phase: 'ready',
        outcome: { kind: 'pending' },
      },
    });

    const ownedWait = waitQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'eligibility-wait',
      nowMs: 200,
    }).transaction;
    expect(
      beginQualificationTransaction(ownedWait, {
        attemptId: 'attempt-2',
        nowMs: 300,
      }).status,
    ).toBe('conflict');
  });

  it('persists retryable no-verdict waits and allows at most one physical runner', () => {
    const waiting = waitQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'eligibility-wait',
      blockers: [{ code: 'quiet-cut', clearEvents: ['checkpoint:eligible:attempt-1'] }],
      nowMs: 200,
    }).transaction;
    expect(waiting).toMatchObject({ phase: 'waiting', waitGeneration: 1, currentPhysicalRunner: null });
    expect(
      waitQualificationTransaction(waiting, {
        attemptId: 'attempt-1',
        reason: 'eligibility-wait',
        blockers: [{ code: 'quiet-cut', clearEvents: ['checkpoint:eligible:attempt-1'] }],
        nowMs: 250,
      }).status,
    ).toBe('idempotent');

    const running = reserveQualificationRunner(waiting, {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      leaseDurationMs: 1_000,
      nowMs: 300,
    }).transaction;
    expect(running).toMatchObject({ phase: 'running', currentPhysicalRunner: { id: 'physical-1' } });
    expect(
      reserveQualificationRunner(running, {
        attemptId: 'attempt-1',
        runnerId: 'physical-1',
        leaseDurationMs: 1_000,
        nowMs: 350,
      }).status,
    ).toBe('idempotent');
    expect(
      reserveQualificationRunner(running, {
        attemptId: 'attempt-1',
        runnerId: 'physical-2',
        leaseDurationMs: 1_000,
        nowMs: 350,
      }).status,
    ).toBe('conflict');
  });

  it('requires proven death before reclaiming even an expired physical runner', () => {
    const running = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      leaseDurationMs: 100,
      nowMs: 200,
    }).transaction;
    expect(projectCheckpointQualificationState(running, 250)).toMatchObject({
      owner: { kind: 'routine', id: 'system:green-checkpoint' },
      lease: { holder: 'physical-1', expired: false },
      safeNextAction: { code: 'await-current-run' },
    });
    expect(projectCheckpointQualificationState(running, 301)).toMatchObject({
      lease: { holder: 'physical-1', expired: true },
      safeNextAction: { code: 'inspect-runner-liveness' },
    });
    expect(projectCheckpointQualificationState(running, 301, 'dead')).toMatchObject({
      runnerHealth: { state: 'dead', liveness: 'dead' },
      safeNextAction: { code: 'recover-expired-runner' },
    });

    const unproven = reserveQualificationRunner(running, {
      attemptId: 'attempt-1', runnerId: 'physical-2', leaseDurationMs: 200, nowMs: 301,
    });
    expect(unproven.status).toBe('conflict');
    const replacement = reserveQualificationRunner(running, {
      attemptId: 'attempt-1',
      runnerId: 'physical-2',
      leaseDurationMs: 200,
      incumbentLiveness: 'dead',
      nowMs: 301,
    });
    expect(replacement).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-1',
        currentPhysicalRunner: { id: 'physical-2', leaseExpiresAtMs: 501 },
        consumedPhysicalRuns: [
          { id: 'physical-1', outcome: { kind: 'pre-suite-no-verdict', reason: 'runner-vanished' } },
        ],
      },
    });
  });

  it('attaches the scheduled CLI process to its pre-spawn reservation without a second runner', () => {
    const placeholder = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'gate-fire-1', leaseDurationMs: 1_000,
      started: false, nowMs: 200,
    }).transaction;
    expect(placeholder).toMatchObject({
      currentPhysicalRunner: { id: 'gate-fire-1', phase: 'launching' },
    });
    expect(placeholder.lastStartedAtMs).toBeUndefined();
    const attached = reserveQualificationRunner(placeholder, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-1', runId: 'cli-run-1',
      candidate: 'candidate-1', pid: 123, pidIdentity: 'boot-a:100',
      leaseDurationMs: 2_000, started: true, nowMs: 300,
    });
    expect(attached).toMatchObject({
      status: 'updated', transaction: {
        runId: 'cli-run-1', lastStartedAtMs: 300,
        currentPhysicalRunner: { id: 'gate-fire-1', pid: 123, pidIdentity: 'boot-a:100', phase: 'materializing' },
        consumedPhysicalRuns: [],
      },
    });
    expect(reserveQualificationRunner(attached.transaction, {
      attemptId: 'attempt-1', runnerId: 'other-fire', leaseDurationMs: 1_000,
      incumbentLiveness: 'live', nowMs: 2_301,
    }).status).toBe('conflict');
    expect(reserveQualificationRunner(attached.transaction, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-1', runId: 'another-cli-run',
      leaseDurationMs: 1_000, started: true, nowMs: 400,
    }).status).toBe('conflict');
  });

  it('lets a live physical-run lease outrank a stale eligibility action', () => {
    const running = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      candidate: 'candidate-1',
      leaseDurationMs: 1_000,
      nowMs: 200,
    }).transaction;
    const staleEligibility = buildCheckpointEligibilitySnapshot({
      attemptId: 'attempt-1',
      candidate: 'candidate-1',
      observedAtMs: 150,
      predicates: CHECKPOINT_ELIGIBILITY_PREDICATES.map((code) => ({
        code,
        status: ['candidate-migrations', 'dependency-generation', 'target-relation-reservation'].includes(code)
          ? ('deferred' as const)
          : ('clear' as const),
        detail: `${code} observed at request time`,
        clearEvents: [],
        evidenceRefs: [`test:${code}`],
      })),
    });
    const withStaleEligibility = {
      ...running,
      eligibilitySnapshot: staleEligibility,
    };

    expect(projectCheckpointQualificationState(withStaleEligibility, 250)).toMatchObject({
      phase: 'running',
      lease: { holder: 'physical-1', expired: false },
      eligibilitySnapshot: { safeNextAction: { code: 'launch-preflight-runner' } },
      safeNextAction: { code: 'await-current-run' },
    });
  });

  it('cancels only the exact attempt/unit and settles a terminal code-inconclusive outcome', () => {
    const running = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      unit: 'papercup-green-checkpoint-manual-ge93sk.service',
      leaseDurationMs: 1_000,
      nowMs: 200,
    }).transaction;

    const cancelled = cancelQualificationTransaction(running, {
      attemptId: 'attempt-1',
      unit: 'papercup-green-checkpoint-manual-ge93sk.service',
      nowMs: 300,
    });
    expect(cancelled).toMatchObject({
      status: 'updated',
      transaction: {
        phase: 'terminal',
        outcome: { kind: 'code-inconclusive', reason: 'cancelled' },
        currentPhysicalRunner: null,
        consumedPhysicalRuns: [
          {
            id: 'physical-1',
            endedAtMs: 300,
            outcome: { kind: 'code-inconclusive', reason: 'cancelled' },
          },
        ],
      },
    });

    expect(
      cancelQualificationTransaction(running, {
        attemptId: 'attempt-1',
        unit: 'another-checkpoint.service',
        nowMs: 300,
      }),
    ).toMatchObject({ status: 'conflict', transaction: running });
    expect(
      cancelQualificationTransaction(running, {
        attemptId: 'attempt-2',
        unit: 'papercup-green-checkpoint-manual-ge93sk.service',
        nowMs: 300,
      }),
    ).toMatchObject({ status: 'conflict', transaction: running });
  });

  it('projects blocker events, elapsed phase durations, terminal action, and consumed runs', () => {
    const running = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      leaseDurationMs: 1_000,
      nowMs: 200,
    }).transaction;
    const waiting = waitQualificationTransaction(running, {
      attemptId: 'attempt-1',
      reason: 'eligibility-wait',
      blockers: [{ code: 'quiet-cut', clearEvents: ['checkpoint:eligible:attempt-1'] }],
      nowMs: 350,
    }).transaction;
    expect(projectCheckpointQualificationState(waiting, 500)).toMatchObject({
      phase: 'waiting',
      phaseDurationsMs: { ready: 100, running: 150, waiting: 150 },
      consumedPhysicalRuns: [{ id: 'physical-1', endedAtMs: 350 }],
      safeNextAction: {
        code: 'await-blocker-events',
        waitEvents: ['checkpoint:eligible:attempt-1'],
      },
    });

    const red = settleQualificationTransaction(waiting, {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 600,
    }).transaction;
    expect(projectCheckpointQualificationState(red, 700)).toMatchObject({
      phase: 'terminal',
      phaseDurationsMs: { ready: 100, running: 150, waiting: 250, terminal: 100 },
      safeNextAction: { code: 'repair-code' },
    });
  });

  it('retries only the explicit pre-suite no-verdict allowlist and makes red/code outcomes terminal', () => {
    expect(classifyQualificationVerdict({ reason: 'migrations-pending', green: null })).toEqual({
      kind: 'pre-suite-no-verdict',
      reason: 'migrations-pending',
    });
    expect(classifyQualificationVerdict({ reason: 'not-green', green: false })).toEqual({
      kind: 'red',
      reason: 'not-green',
    });
    expect(classifyQualificationVerdict({ reason: 'not-fast-forward', green: null })).toEqual({
      kind: 'code-inconclusive',
      reason: 'not-fast-forward',
    });

    const red = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;
    expect(red).toMatchObject({ phase: 'terminal', outcome: { kind: 'red' }, currentPhysicalRunner: null });
    expect(
      waitQualificationTransaction(red, {
        attemptId: 'attempt-1',
        reason: 'eligibility-wait',
        nowMs: 500,
      }).status,
    ).toBe('terminal');
  });

  it('fails closed on malformed nested metadata instead of trusting a shallow record cast', () => {
    const current = begin();
    expect(parseCheckpointQualificationTransaction(current)).toEqual(current);
    expect(
      parseCheckpointQualificationTransaction({
        ...current,
        currentPhysicalRunner: {
          id: 'physical-1',
          candidate: null,
          reservedAtMs: 'not-a-number',
          evidenceRefs: [],
        },
      }),
    ).toBeNull();
    expect(
      parseCheckpointQualificationTransaction({
        ...current,
        outcome: { kind: 'pre-suite-no-verdict', reason: 'invented-retry' },
      }),
    ).toBeNull();
    expect(
      parseCheckpointQualificationTransaction({
        ...current,
        phaseDurationsMs: { running: -1 },
      }),
    ).toBeNull();
    expect(
      parseCheckpointQualificationTransaction({
        ...current,
        consumedPhysicalRuns: [{ id: 'run-1', outcome: { kind: 'invented' } }],
      }),
    ).toBeNull();
  });

  it('retires only the predecessor-linked safe unstarted queue for a distinct successor', () => {
    const terminal = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;
    const safeQueue = createFrozenCandidateQueue({
      candidate: 'candidate-1',
      qualificationAttemptId: 'attempt-1',
      base: null,
      nowMs: 200,
    });
    const successor = {
      attemptId: 'attempt-2',
      requiredAncestorSha: 'successor-repair',
      declaredPaths: ['fixed.ts'],
      candidate: 'candidate-2',
      nowMs: 500,
    };

    expect(assessTerminalRepairQueueReconciliation(terminal, successor, safeQueue)).toMatchObject({
      status: 'retired',
      reason: 'exact-safe-unstarted',
      predecessorAttemptId: 'attempt-1',
      successorAttemptId: 'attempt-2',
      candidate: 'candidate-1',
    });
    expect(
      assessTerminalRepairQueueReconciliation(terminal, successor, {
        ...safeQueue,
        qualificationAttemptId: 'another-attempt',
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-mismatch' });
    expect(
      assessTerminalRepairQueueReconciliation(
        terminal,
        successor,
        markFrozenCandidateVerificationRed(safeQueue, {
          failingTests: ['broken.test.ts'],
          nowMs: 300,
        }),
      ),
    ).toMatchObject({ status: 'blocked', reason: 'queue-not-safe-unstarted' });
  });

  it('preserves a predecessor-linked repair head that is ready for its first verification', () => {
    const terminal = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;
    const redCandidate = markFrozenCandidateVerificationRed(
      createFrozenCandidateQueue({
        candidate: 'candidate-1',
        qualificationAttemptId: 'attempt-1',
        base: null,
        nowMs: 200,
      }),
      {
        failingTests: ['broken.test.ts'],
        nowMs: 300,
      },
    );
    const readyToVerify = markFrozenRepairAdmitted(redCandidate, {
      atMs: 350,
      actor: 'agent-1',
      source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1',
      toRepairHead: 'repair-1',
      paths: ['fixed.ts'],
      unchanged: [],
      blobs: { 'fixed.ts': 'blob-1' },
    });
    const successor = {
      attemptId: 'attempt-2',
      requiredAncestorSha: 'repair-1',
      declaredPaths: [],
      candidate: 'candidate-2',
      nowMs: 500,
    };

    expect(assessTerminalRepairQueueReconciliation(terminal, successor, readyToVerify)).toMatchObject({
      status: 'preserved',
      reason: 'matching-untested-repair-head',
      predecessorAttemptId: 'attempt-1',
      successorAttemptId: 'attempt-2',
      candidate: 'candidate-1',
    });
    expect(
      assessTerminalRepairQueueReconciliation(terminal, successor, {
        ...readyToVerify,
        qualificationAttemptId: null,
      }),
    ).toMatchObject({ status: 'preserved', reason: 'matching-untested-repair-head' });
    expect(
      assessTerminalRepairQueueReconciliation(
        terminal,
        { ...successor, requiredAncestorSha: 'different-repair' },
        { ...readyToVerify, qualificationAttemptId: null },
      ),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-unknown' });
    expect(
      assessTerminalRepairQueueReconciliation(terminal, successor, {
        ...readyToVerify,
        convergenceRounds: [
          ...(readyToVerify.convergenceRounds ?? []),
          { round: 2, head: 'repair-1', failingCount: 1, atMs: 360 },
        ],
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-not-safe-unstarted' });
  });

  it('preserves a completed-fixer repair head whose spawn id is retained as provenance', () => {
    const terminal = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;
    const redCandidate = markFrozenCandidateVerificationRed(
      createFrozenCandidateQueue({
        candidate: 'candidate-1',
        qualificationAttemptId: 'attempt-1',
        base: null,
        nowMs: 200,
      }),
      { failingTests: ['broken.test.ts'], nowMs: 300 },
    );
    // A completed fixer is represented by ready-to-verify plus its historical spawn id;
    // the id is deliberately retained for lineage diagnostics and is not a live lease.
    const completedFixerQueue = {
      ...markFrozenRepairAdmitted(redCandidate, {
        atMs: 350,
        actor: 'agent-1',
        source: { ref: 'staging', sha: 'repair-1' },
        fromRepairHead: 'candidate-1',
        toRepairHead: 'repair-1',
        paths: ['fixed.ts'],
        unchanged: [],
        blobs: { 'fixed.ts': 'blob-1' },
      }),
      fixerSpawnId: 'completed-fixer-1',
    };
    expect(completedFixerQueue.phase).toBe('ready-to-verify');

    expect(
      assessTerminalRepairQueueReconciliation(
        terminal,
        {
          attemptId: 'attempt-2',
          requiredAncestorSha: 'repair-1',
          declaredPaths: [],
          candidate: 'candidate-2',
          nowMs: 500,
        },
        completedFixerQueue,
      ),
    ).toMatchObject({
      status: 'preserved',
      reason: 'matching-untested-repair-head',
      candidate: 'candidate-1',
    });
  });

  it('preserves an untested repair head linked through the terminal attempt immediate predecessor', () => {
    const firstTerminal = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;
    const inherited = beginQualificationTransaction(firstTerminal, {
      attemptId: 'attempt-2',
      requiredAncestorSha: 'candidate-1',
      candidate: 'candidate-1',
      nowMs: 450,
    }).transaction;
    const current = settleQualificationTransaction(inherited, {
      attemptId: 'attempt-2',
      reason: 'dependency-prewarm-missing',
      nowMs: 500,
    }).transaction;
    expect(current).toMatchObject({
      attemptId: 'attempt-2',
      previousAttemptId: 'attempt-1',
      phase: 'terminal',
      outcome: { kind: 'code-inconclusive' },
    });

    const redCandidate = markFrozenCandidateVerificationRed(
      createFrozenCandidateQueue({
        candidate: 'candidate-1',
        qualificationAttemptId: 'attempt-1',
        base: null,
        nowMs: 200,
      }),
      {
        failingTests: ['broken.test.ts'],
        nowMs: 300,
      },
    );
    const readyToVerify = markFrozenRepairAdmitted(redCandidate, {
      atMs: 350,
      actor: 'agent-1',
      source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1',
      toRepairHead: 'repair-1',
      paths: ['fixed.ts'],
      unchanged: [],
      blobs: { 'fixed.ts': 'blob-1' },
    });
    const successor = {
      attemptId: 'attempt-3',
      requiredAncestorSha: 'repair-1',
      declaredPaths: ['fixed.ts'],
      candidate: 'candidate-2',
      nowMs: 600,
    };

    expect(assessTerminalRepairQueueReconciliation(current, successor, readyToVerify)).toMatchObject({
      status: 'preserved',
      reason: 'matching-untested-repair-head',
      predecessorAttemptId: 'attempt-2',
      successorAttemptId: 'attempt-3',
      candidate: 'candidate-1',
    });
    expect(
      assessTerminalRepairQueueReconciliation(current, successor, {
        ...readyToVerify,
        qualificationAttemptId: 'unrelated-attempt',
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-mismatch' });
    expect(
      assessTerminalRepairQueueReconciliation(current, successor, {
        ...readyToVerify,
        convergenceRounds: [
          ...(readyToVerify.convergenceRounds ?? []),
          { round: 2, head: 'repair-1', failingCount: 1, atMs: 550 },
        ],
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-mismatch' });
  });

  // WI-2142947: a NULL qualificationAttemptId (schema v3 permits this, WI-41667) is an
  // ABSENCE of provenance, not evidence of a competing owner. It must not be treated as a
  // permanent 'queue-origin-mismatch' fail-close; it falls through to the same
  // phase/attempts/fixer safety checks as a known-matching origin.
  it('judges a null-origin queue (unknown provenance) on its actual state instead of permanently fail-closing it', () => {
    const terminal = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;
    const safeQueue = createFrozenCandidateQueue({
      candidate: 'candidate-1',
      qualificationAttemptId: 'attempt-1',
      base: null,
      nowMs: 200,
    });
    const successor = {
      attemptId: 'attempt-2',
      requiredAncestorSha: 'successor-repair',
      declaredPaths: ['fixed.ts'],
      candidate: 'candidate-2',
      nowMs: 500,
    };

    // Null-origin AND exact/safe/unstarted -> retired, same as a known-matching origin. This
    // is the concrete case that used to permanently fail-close manual release:checkpoint-run.
    expect(
      assessTerminalRepairQueueReconciliation(terminal, successor, {
        ...safeQueue,
        qualificationAttemptId: undefined,
      }),
    ).toMatchObject({
      status: 'retired',
      reason: 'exact-safe-unstarted',
      predecessorAttemptId: 'attempt-1',
      successorAttemptId: 'attempt-2',
      candidate: 'candidate-1',
    });

    // Null-origin but genuinely NOT idle (mid-repair) -> still blocked, but diagnosable as
    // origin-unknown rather than reading like a takeover race against a known owner.
    expect(
      assessTerminalRepairQueueReconciliation(
        terminal,
        successor,
        markFrozenCandidateVerificationRed(
          { ...safeQueue, qualificationAttemptId: undefined },
          { failingTests: ['broken.test.ts'], nowMs: 300 },
        ),
      ),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-unknown' });

    // A KNOWN, DIFFERENT origin is still a genuine mismatch and stays fail-closed forever.
    expect(
      assessTerminalRepairQueueReconciliation(terminal, successor, {
        ...safeQueue,
        qualificationAttemptId: 'another-attempt',
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-mismatch' });
  });
});
