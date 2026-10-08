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
  markFrozenRepairVerificationGreen,
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

  it('settles a repair-head verification whose verdict names the frozen candidate plus the verified head (WI-10002602)', () => {
    // The attempt is reserved against the repair head it verifies ('repair-head-1'), but the
    // green-checkpoint verdict names the FROZEN candidate as `candidate` and the verified head
    // as `repairHead`. Before the fix this returned conflict: the verdict was discarded and the
    // attempt stayed non-terminal, wedging every later scheduled fire.
    const reserved = reserveQualificationRunner(
      beginQualificationTransaction(null, {
        attemptId: 'attempt-rh',
        requiredAncestorSha: 'repair-head-1',
        candidate: 'repair-head-1',
        nowMs: 100,
      }).transaction,
      { attemptId: 'attempt-rh', runnerId: 'physical-rh', candidate: 'repair-head-1', leaseDurationMs: 1_000, nowMs: 150 },
    ).transaction;

    const settled = settleQualificationTransaction(reserved, {
      attemptId: 'attempt-rh',
      candidate: 'frozen-candidate-1',
      repairHead: 'repair-head-1',
      reason: 'repair-in-progress',
      green: null,
      nowMs: 200,
    });
    // repair-in-progress is a no-verdict: the attempt returns to waiting with its runner
    // released, instead of staying 'running' under a runner that will never settle it.
    expect(settled.status).toBe('updated');
    expect(settled.transaction).toMatchObject({
      phase: 'waiting',
      candidate: 'frozen-candidate-1',
      repairHead: 'repair-head-1',
      currentPhysicalRunner: null,
    });

    // A real verdict on the same repair head settles terminally.
    const red = settleQualificationTransaction(reserved, {
      attemptId: 'attempt-rh',
      candidate: 'frozen-candidate-1',
      repairHead: 'repair-head-1',
      reason: 'not-green',
      green: false,
      nowMs: 200,
    });
    expect(red.status).toBe('updated');
    expect(red.transaction).toMatchObject({ phase: 'terminal', repairHead: 'repair-head-1' });

    // A verdict for a DIFFERENT repair head is still a stale producer and must not settle.
    const otherHead = settleQualificationTransaction(reserved, {
      attemptId: 'attempt-rh',
      candidate: 'frozen-candidate-1',
      repairHead: 'repair-head-2',
      reason: 'repair-in-progress',
      green: null,
      nowMs: 200,
    });
    expect(otherHead).toMatchObject({ status: 'conflict', transaction: reserved });
  });

  it('settles the incumbent run verdict for the sha it actually judged after re-resolving its target (WI-10003215)', () => {
    // Incident shape (attempt 1cf6ef83, run e787243b): the scheduled reservation stored the quiet-cut
    // tip, the run resumed the frozen lineage, its own lockfile convergence advanced repairHead
    // (persisting pendingRepairHead), and the green verdict named the converged head with no repair
    // head because promotion retired the queue. Before the fix this returned conflict: the green was
    // DISCARDED, release:green wakes were withheld, and the attempt stayed running under a dead runner.
    const placeholder = reserveQualificationRunner(
      beginQualificationTransaction(null, {
        attemptId: 'attempt-conv', requiredAncestorSha: 'tip-cut', candidate: 'tip-cut', nowMs: 100,
      }).transaction,
      { attemptId: 'attempt-conv', runnerId: 'gate-fire-conv', leaseDurationMs: 1_000, started: false, nowMs: 150 },
    ).transaction;
    const running = reserveQualificationRunner(placeholder, {
      attemptId: 'attempt-conv', runnerId: 'gate-fire-conv', runId: 'run-conv', candidate: 'tip-cut',
      pid: 42, pidIdentity: 'boot-a:42', leaseDurationMs: 2_000, started: true, nowMs: 200,
      evidenceRefs: ['checkpoint-run:run-conv'],
    }).transaction;
    const converged = { ...running, pendingRepairHead: 'converged-head' };
    expect(converged.currentPhysicalRunner?.evidenceRefs).toContain('checkpoint-run:run-conv');

    const green = { attemptId: 'attempt-conv', candidate: 'converged-head', reason: 'advanced', green: true, nowMs: 300 };
    const settled = settleQualificationTransaction(converged, { ...green, runId: 'run-conv' });
    expect(settled.status).toBe('updated');
    expect(settled.transaction).toMatchObject({
      phase: 'terminal',
      outcome: { kind: 'green' },
      candidate: 'converged-head',
      repairHead: 'converged-head',
      pendingRepairHead: null,
      currentPhysicalRunner: null,
    });
    expect(describeQualificationSettleConflict(converged, { ...green, runId: 'run-conv' })).toEqual([]);
    // An exact replay of the same verdict is idempotent, not a second terminal event.
    expect(settleQualificationTransaction(settled.transaction, { ...green, runId: 'run-conv' }).status).toBe('terminal');

    // A red from the same run on a still-frozen queue names the frozen candidate plus the converged
    // head; it settles too and consumes the handoff.
    const red = settleQualificationTransaction(converged, {
      attemptId: 'attempt-conv', candidate: 'frozen-candidate', repairHead: 'converged-head',
      runId: 'run-conv', reason: 'not-green', green: false, nowMs: 300,
    });
    expect(red.transaction).toMatchObject({
      phase: 'terminal', candidate: 'frozen-candidate', repairHead: 'converged-head', pendingRepairHead: null,
    });

    // A handoff the run did NOT judge (a later admission) survives for the successor attempt.
    const laterAdmission = settleQualificationTransaction(
      { ...running, pendingRepairHead: 'later-admission' },
      { ...green, runId: 'run-conv' },
    );
    expect(laterAdmission.transaction).toMatchObject({ phase: 'terminal', pendingRepairHead: 'later-admission' });

    // Identity is still enforced: a candidate mismatch settles ONLY for the incumbent's bound run.
    for (const stale of [
      { runId: 'run-other' },
      { runId: null },
    ]) {
      expect(settleQualificationTransaction(converged, { ...green, ...stale })).toMatchObject({
        status: 'conflict', transaction: converged,
      });
    }
    // A stored run id the live runner never bound (inherited history) is not proof of the same run.
    const unbound = {
      ...converged,
      currentPhysicalRunner: { ...converged.currentPhysicalRunner!, evidenceRefs: [] as string[] },
    };
    expect(settleQualificationTransaction(unbound, { ...green, runId: 'run-conv' }).status).toBe('conflict');
    expect(describeQualificationSettleConflict(unbound, { ...green, runId: 'run-conv' })).toEqual([
      'candidate stored=tip-cut produced=converged-head',
    ]);
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

  it('never lets a fresh runner inherit the run id bound to an ended runner (WI-10002602 re-wedge)', () => {
    // First scheduled runner binds run-1, then settles pre-suite (waiting, runner released).
    const reserved1 = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'gate-fire-1', leaseDurationMs: 1_000, started: false, nowMs: 200,
    }).transaction;
    const started1 = reserveQualificationRunner(reserved1, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-1', runId: 'run-1', candidate: 'candidate-1',
      pid: 11, pidIdentity: 'boot-a:11', leaseDurationMs: 2_000, started: true, nowMs: 300,
      evidenceRefs: ['checkpoint-run:run-1'],
    }).transaction;
    const waiting = settleQualificationTransaction(started1, {
      attemptId: 'attempt-1', reason: 'repair-in-progress', candidate: 'candidate-1', runId: 'run-1', nowMs: 400,
    });
    expect(waiting).toMatchObject({ status: 'updated', transaction: { phase: 'waiting', runId: 'run-1', currentPhysicalRunner: null } });

    // A later fire reserves a NEW runner: run-1 belongs to the consumed runner, so it is not inherited.
    const reserved2 = reserveQualificationRunner(waiting.transaction, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-2', leaseDurationMs: 1_000, started: false, nowMs: 500,
    });
    expect(reserved2).toMatchObject({ status: 'updated', transaction: { runId: null, phase: 'running' } });
    const attach = (from: typeof waiting.transaction) => reserveQualificationRunner(from, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-2', runId: 'run-2', candidate: 'candidate-1',
      pid: 22, pidIdentity: 'boot-a:22', leaseDurationMs: 2_000, started: true, nowMs: 600,
      evidenceRefs: ['checkpoint-run:run-2'],
    });
    expect(attach(reserved2.transaction)).toMatchObject({ status: 'updated', transaction: { runId: 'run-2' } });

    // A row ALREADY wedged by the old code (the new runner inherited run-1) still activates.
    const wedged = { ...reserved2.transaction, runId: 'run-1' };
    const unwedged = attach(wedged);
    expect(unwedged).toMatchObject({
      status: 'updated',
      transaction: { runId: 'run-2', currentPhysicalRunner: { id: 'gate-fire-2', phase: 'materializing' } },
    });
    // ... and a verdict from the new run settles against it instead of being discarded.
    expect(settleQualificationTransaction(wedged, {
      attemptId: 'attempt-1', reason: 'not-green', green: false, candidate: 'candidate-1', runId: 'run-2', nowMs: 650,
    }).status).toBe('updated');

    // Single flight is intact: once run-2 is bound to the live runner, a different run id conflicts
    // on activation, and a zombie verdict from ended run-1 cannot settle the attempt.
    expect(reserveQualificationRunner(unwedged.transaction, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-2', runId: 'run-3', leaseDurationMs: 1_000,
      started: true, nowMs: 700, evidenceRefs: ['checkpoint-run:run-3'],
    }).status).toBe('conflict');
    expect(settleQualificationTransaction(unwedged.transaction, {
      attemptId: 'attempt-1', reason: 'not-green', green: false, candidate: 'candidate-1', runId: 'run-1', nowMs: 800,
    }).status).toBe('conflict');
  });

  it('binds a run that settles BEFORE activating to its released runner, so no fresh runner inherits it (WI-10003212)', () => {
    // A scheduled reservation whose CLI lock-skips: it settles `skipped-locked` without ever
    // attaching, so the runner never recorded `checkpoint-run:skipped-run`.
    const reserved1 = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'gate-fire-1', leaseDurationMs: 1_000, started: false, nowMs: 200,
    }).transaction;
    const skipped = settleQualificationTransaction(reserved1, {
      attemptId: 'attempt-1', reason: 'skipped-locked', candidate: 'candidate-1', runId: 'skipped-run', nowMs: 300,
    });
    expect(skipped).toMatchObject({ status: 'updated', transaction: { phase: 'waiting', runId: 'skipped-run' } });
    expect(skipped.transaction.consumedPhysicalRuns?.at(-1)).toMatchObject({
      id: 'gate-fire-1', evidenceRefs: expect.arrayContaining(['checkpoint-run:skipped-run']),
    });

    // The next fire's fresh reservation does not inherit the skipped run's id ...
    const reserved2 = reserveQualificationRunner(skipped.transaction, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-2', leaseDurationMs: 1_000, started: false, nowMs: 400,
    });
    expect(reserved2).toMatchObject({ status: 'updated', transaction: { runId: null } });
    // ... so its own CLI activates instead of being refused `run stored=skipped-run produced=run-2`.
    expect(reserveQualificationRunner(reserved2.transaction, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-2', runId: 'run-2', candidate: 'candidate-1',
      pid: 22, pidIdentity: 'boot-a:22', leaseDurationMs: 2_000, started: true, nowMs: 500,
      evidenceRefs: ['checkpoint-run:run-2'],
    })).toMatchObject({ status: 'updated', transaction: { runId: 'run-2' } });
  });

  it('recovers a row already wedged on an orphaned run id that aged out of history (WI-10003212)', () => {
    // Pre-fix shape: the attempt holds `orphan-run`, bound to no runner (the lock-skipped runner
    // aged out of the 32-run window), and a fresh scheduled placeholder inherited it.
    const placeholder = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'gate-fire-9', leaseDurationMs: 1_000, started: false, nowMs: 200,
    }).transaction;
    const wedged = { ...placeholder, runId: 'orphan-run' };
    const attach = (from: Parameters<typeof reserveQualificationRunner>[0], runId: string, pid: number) => reserveQualificationRunner(from, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-9', runId, candidate: 'candidate-1',
      pid, pidIdentity: `boot-a:${pid}`, leaseDurationMs: 2_000, started: true, nowMs: 300,
      evidenceRefs: [`checkpoint-run:${runId}`],
    });
    const recovered = attach(wedged, 'run-9', 99);
    expect(recovered).toMatchObject({
      status: 'updated',
      transaction: { runId: 'run-9', currentPhysicalRunner: { id: 'gate-fire-9', phase: 'materializing', pid: 99 } },
    });
    // Once a CLI has attached, single flight holds: a different run id against it conflicts.
    expect(attach(recovered.transaction, 'run-10', 100).status).toBe('conflict');
  });

  it('pins a terminal verdict to its own run id even when no runner was ever reserved', () => {
    // WI-10003212 made WAITS refuse to store an unbound run id (a fresh runner inherited it). A
    // terminal attempt refuses every later reservation, so its pin cannot be inherited — and
    // without it a DIFFERENT run's replay reads as an idempotent `terminal` instead of a conflict.
    const settled = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1', candidate: 'candidate-1', runId: 'run-terminal',
      reason: 'not-green', green: false, nowMs: 200,
    });
    expect(settled).toMatchObject({ status: 'updated', transaction: { phase: 'terminal', runId: 'run-terminal' } });
    const replay = { attemptId: 'attempt-1', candidate: 'candidate-1', reason: 'not-green', green: false, nowMs: 300 };
    expect(settleQualificationTransaction(settled.transaction, { ...replay, runId: 'run-terminal' }).status).toBe('terminal');
    expect(settleQualificationTransaction(settled.transaction, { ...replay, runId: 'run-other' }).status).toBe('conflict');
    expect(reserveQualificationRunner(settled.transaction, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-late', leaseDurationMs: 1_000, started: false, nowMs: 400,
    }).status).toBe('terminal');
  });

  it('never stores a released run id that no runner can carry (WI-10003212)', () => {
    // run-1 activated and is bound to gate-fire-1; a late wait from an unrelated run must not
    // overwrite the attempt's run id with an unattributable one, nor re-bind gate-fire-1.
    const reserved = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'gate-fire-1', leaseDurationMs: 1_000, started: false, nowMs: 200,
    }).transaction;
    const started = reserveQualificationRunner(reserved, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-1', runId: 'run-1', candidate: 'candidate-1',
      pid: 11, pidIdentity: 'boot-a:11', leaseDurationMs: 2_000, started: true, nowMs: 300,
      evidenceRefs: ['checkpoint-run:run-1'],
    }).transaction;
    const waited = waitQualificationTransaction(started, {
      attemptId: 'attempt-1', reason: 'repair-in-progress', runId: 'stray-run', nowMs: 400,
    });
    expect(waited).toMatchObject({ status: 'updated', transaction: { runId: 'run-1' } });
    const released = waited.transaction.consumedPhysicalRuns?.at(-1);
    expect(released?.evidenceRefs).toContain('checkpoint-run:run-1');
    expect(released?.evidenceRefs).not.toContain('checkpoint-run:stray-run');
    // With no runner at all, an unbound id is likewise not stored.
    const again = waitQualificationTransaction(waited.transaction, {
      attemptId: 'attempt-1', reason: 'wait-for-eligibility-unavailable', runId: 'stray-run', nowMs: 500,
    });
    expect(again.transaction.runId).toBe('run-1');
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
    expect(classifyQualificationVerdict({ reason: 'skipped-locked', green: null })).toEqual({
      kind: 'pre-suite-no-verdict',
      reason: 'skipped-locked',
    });
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
    // A measured red is never RETIRED. Since WI-10007398 the unassigned awaiting-fixer queue it
    // leaves is handed to the successor (preserved) rather than blocking it; see the dedicated
    // test below for why a block here deadlocked the gate.
    expect(
      assessTerminalRepairQueueReconciliation(
        terminal,
        successor,
        markFrozenCandidateVerificationRed(safeQueue, {
          failingTests: ['broken.test.ts'],
          nowMs: 300,
        }),
      ),
    ).toMatchObject({ status: 'preserved', reason: 'awaiting-unassigned-fixer' });
  });

  // WI-10007398: the run that measures a red moves the queue to awaiting-fixer and exits; the
  // fixer is dispatched by the NEXT run's `dispatch-fixer` decision. Refusing that successor at
  // begin (queue-not-safe-unstarted) closed the only automatic path — measured 2026-10-07/08:
  // 13 consecutive hourly ticks refused with attempts=0, fixerSpawnId=null, nobody dispatched.
  it('hands an unassigned awaiting-fixer queue to the successor so its run can dispatch the fixer', () => {
    const awaitingFixer = markFrozenCandidateVerificationRed(
      createFrozenCandidateQueue({ candidate: 'candidate-1', qualificationAttemptId: 'attempt-1', base: null, nowMs: 200 }),
      { failingTests: ['broken.test.ts'], nowMs: 300 },
    );
    expect(awaitingFixer.phase).toBe('awaiting-fixer');
    expect(awaitingFixer.fixerSpawnId).toBeNull();
    const successor = { attemptId: 'attempt-2', declaredPaths: [], candidate: 'candidate-2', nowMs: 500 };
    // The live shape: a terminal code-inconclusive attempt owns the queue.
    const inconclusive = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'error',
      green: null,
      nowMs: 400,
    }).transaction;
    expect(inconclusive.outcome.kind).toBe('code-inconclusive');
    const red = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;

    for (const terminal of [inconclusive, red]) {
      expect(assessTerminalRepairQueueReconciliation(terminal, successor, awaitingFixer)).toMatchObject({
        status: 'preserved',
        reason: 'awaiting-unassigned-fixer',
        predecessorAttemptId: 'attempt-1',
        successorAttemptId: 'attempt-2',
        candidate: 'candidate-1',
      });
    }
    // An EXPIRED reservation is abandoned — the queue policy dispatches past it, so must begin.
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, successor, {
        ...awaitingFixer,
        dispatchReservation: { token: 'stale', claimedAtMs: 100, expiresAtMs: 499 },
      }),
    ).toMatchObject({ status: 'preserved', reason: 'awaiting-unassigned-fixer' });

    // Negative controls — each keeps the fail-closed verdict.
    // A fixer is assigned: it advances the queue itself by admission.
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, successor, { ...awaitingFixer, fixerSpawnId: 's-live' }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-not-safe-unstarted' });
    // A launch is in flight under an unexpired reservation.
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, successor, {
        ...awaitingFixer,
        dispatchReservation: { token: 'live', claimedAtMs: 450, expiresAtMs: 9_999_999 },
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-not-safe-unstarted' });
    // Someone else's queue.
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, successor, {
        ...awaitingFixer,
        qualificationAttemptId: 'someone-else',
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-mismatch' });
    // Unknown origin is not enough on its own for this handoff.
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, successor, {
        ...awaitingFixer,
        qualificationAttemptId: null,
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-unknown' });
  });

  // EI-24610407938327281: a green advance whose P-008 staging bridge lost the git-sync lock
  // leaves `ready-to-promote` as the retry marker. Blocking the successor qualification
  // made that retry unreachable and deadlocked the gate for hours.
  it('preserves a promoted ready-to-promote queue so the next run can retry the staging bridge', () => {
    const provenGreen = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'advanced',
      green: true,
      nowMs: 400,
    }).transaction;
    // Built through the real transitions (red → admit → verification green) so the
    // parser accepts it exactly as it accepts the live row.
    const promoted = markFrozenRepairVerificationGreen(
      markFrozenRepairAdmitted(
        markFrozenCandidateVerificationRed(
          createFrozenCandidateQueue({ candidate: 'frozen-0', qualificationAttemptId: 'attempt-1', base: null, nowMs: 200 }),
          { failingTests: ['broken.test.ts'], nowMs: 250 },
        ),
        {
          atMs: 300,
          actor: 'agent-1',
          source: { ref: 'staging', sha: 'candidate-1' },
          fromRepairHead: 'frozen-0',
          toRepairHead: 'candidate-1',
          paths: ['fixed.ts'],
          unchanged: [],
          blobs: { 'fixed.ts': 'blob-1' },
        },
      ),
      { repairHead: 'candidate-1', nowMs: 350 },
    );
    expect(promoted.phase).toBe('ready-to-promote');
    const successor = { attemptId: 'attempt-2', declaredPaths: [], candidate: 'candidate-2', nowMs: 500 };

    expect(assessTerminalRepairQueueReconciliation(provenGreen, successor, promoted)).toMatchObject({
      status: 'preserved',
      reason: 'promoted-awaiting-staging-bridge',
      predecessorAttemptId: 'attempt-1',
      successorAttemptId: 'attempt-2',
    });
    // Negative controls — each keeps the old fail-closed verdict.
    const red = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;
    expect(assessTerminalRepairQueueReconciliation(red, successor, promoted)).toMatchObject({
      status: 'blocked',
      reason: 'queue-not-safe-unstarted',
    });
    expect(
      assessTerminalRepairQueueReconciliation(provenGreen, successor, { ...promoted, repairHead: 'other-head' }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-not-safe-unstarted' });
    expect(
      assessTerminalRepairQueueReconciliation(provenGreen, successor, {
        ...promoted,
        qualificationAttemptId: 'someone-else',
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-mismatch' });

    // Measured 2026-09-30 (queue 9a4319b70a): the preserved retry itself lost the git-sync lock
    // and settled code-inconclusive on a TIP candidate while re-stamping the queue as its own.
    // That no-verdict attempt must hand the retry marker forward, or the deadlock recurs one
    // retry later. A red retry still fails closed (asserted above for the same queue shape).
    const retryInconclusive = settleQualificationTransaction(
      beginQualificationTransaction(null, {
        attemptId: 'attempt-2',
        declaredPaths: [],
        candidate: 'tip-2',
        evidenceRefs: ['gate-fire:attempt-2'],
        nowMs: 500,
      }).transaction,
      { attemptId: 'attempt-2', reason: 'error', green: null, nowMs: 600 },
    ).transaction;
    expect(retryInconclusive.outcome.kind).toBe('code-inconclusive');
    const restamped = { ...promoted, qualificationAttemptId: 'attempt-2' };
    const nextSuccessor = { attemptId: 'attempt-3', declaredPaths: [], candidate: 'tip-3', nowMs: 700 };
    expect(assessTerminalRepairQueueReconciliation(retryInconclusive, nextSuccessor, restamped)).toMatchObject({
      status: 'preserved',
      reason: 'promoted-awaiting-staging-bridge',
      predecessorAttemptId: 'attempt-2',
      successorAttemptId: 'attempt-3',
    });
    expect(
      assessTerminalRepairQueueReconciliation(retryInconclusive, nextSuccessor, {
        ...restamped,
        dispatchReservation: { token: 'fixer-1', claimedAtMs: 650, expiresAtMs: 9_999_999 },
      }),
    ).toMatchObject({ status: 'blocked' });
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
