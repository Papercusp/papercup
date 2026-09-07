import { describe, expect, it } from 'vitest';
import {
  assessTerminalRepairQueueReconciliation,
  beginQualificationTransaction,
  classifyQualificationVerdict,
  parseCheckpointQualificationTransaction,
  projectCheckpointQualificationState,
  qualificationIntentMatches,
  reserveQualificationRunner,
  settleQualificationTransaction,
  waitQualificationTransaction,
} from './checkpoint-qualification-transaction';
import {
  createFrozenCandidateQueue,
  markFrozenCandidateVerificationRed,
  markFrozenRepairAdmitted,
} from './frozen-candidate-repair-queue';

const begin = () => beginQualificationTransaction(null, {
  attemptId: 'attempt-1',
  requiredAncestorSha: 'abc123',
  declaredPaths: ['b.ts', 'a.ts', 'a.ts'],
  candidate: 'candidate-1',
  evidenceRefs: ['tool:release:checkpoint-run'],
  nowMs: 100,
}).transaction;

describe('logical checkpoint qualification transaction', () => {
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
    expect(qualificationIntentMatches(current, {
      requiredAncestorSha: 'abc123',
      declaredPaths: ['a.ts', 'b.ts'],
    })).toBe(true);
    expect(qualificationIntentMatches(current, {
      requiredAncestorSha: 'different',
      declaredPaths: ['a.ts', 'b.ts'],
    })).toBe(false);
  });

  it('releases the singleton when an eligibility waiter never started, while preserving real waits', () => {
    const unavailable = waitQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'wait-for-eligibility-unavailable',
      blockers: [{
        code: 'dbos-eligibility-waiter',
        detail: 'DBOS is not installed',
        clearEvents: [],
      }],
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
    expect(beginQualificationTransaction(ownedWait, {
      attemptId: 'attempt-2',
      nowMs: 300,
    }).status).toBe('conflict');
  });

  it('persists retryable no-verdict waits and allows at most one physical runner', () => {
    const waiting = waitQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'eligibility-wait',
      blockers: [{ code: 'quiet-cut', clearEvents: ['checkpoint:eligible:attempt-1'] }],
      nowMs: 200,
    }).transaction;
    expect(waiting).toMatchObject({ phase: 'waiting', waitGeneration: 1, currentPhysicalRunner: null });
    expect(waitQualificationTransaction(waiting, {
      attemptId: 'attempt-1',
      reason: 'eligibility-wait',
      blockers: [{ code: 'quiet-cut', clearEvents: ['checkpoint:eligible:attempt-1'] }],
      nowMs: 250,
    }).status).toBe('idempotent');

    const running = reserveQualificationRunner(waiting, {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      leaseDurationMs: 1_000,
      nowMs: 300,
    }).transaction;
    expect(running).toMatchObject({ phase: 'running', currentPhysicalRunner: { id: 'physical-1' } });
    expect(reserveQualificationRunner(running, {
      attemptId: 'attempt-1', runnerId: 'physical-1', leaseDurationMs: 1_000, nowMs: 350,
    }).status).toBe('idempotent');
    expect(reserveQualificationRunner(running, {
      attemptId: 'attempt-1', runnerId: 'physical-2', leaseDurationMs: 1_000, nowMs: 350,
    }).status).toBe('conflict');
  });

  it('expires a mortal physical runner while preserving the logical attempt and run history', () => {
    const running = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'physical-1', leaseDurationMs: 100, nowMs: 200,
    }).transaction;
    expect(projectCheckpointQualificationState(running, 250)).toMatchObject({
      owner: { kind: 'routine', id: 'system:green-checkpoint' },
      lease: { holder: 'physical-1', expired: false },
      safeNextAction: { code: 'await-current-run' },
    });
    expect(projectCheckpointQualificationState(running, 301)).toMatchObject({
      lease: { holder: 'physical-1', expired: true },
      safeNextAction: { code: 'recover-expired-runner' },
    });

    const replacement = reserveQualificationRunner(running, {
      attemptId: 'attempt-1', runnerId: 'physical-2', leaseDurationMs: 200, nowMs: 301,
    });
    expect(replacement).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-1',
        currentPhysicalRunner: { id: 'physical-2', leaseExpiresAtMs: 501 },
        consumedPhysicalRuns: [{ id: 'physical-1', outcome: { kind: 'pre-suite-no-verdict', reason: 'deadline-exceeded' } }],
      },
    });
  });

  it('projects blocker events, elapsed phase durations, terminal action, and consumed runs', () => {
    const running = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'physical-1', leaseDurationMs: 1_000, nowMs: 200,
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
      attemptId: 'attempt-1', reason: 'not-green', green: false, nowMs: 600,
    }).transaction;
    expect(projectCheckpointQualificationState(red, 700)).toMatchObject({
      phase: 'terminal',
      phaseDurationsMs: { ready: 100, running: 150, waiting: 250, terminal: 100 },
      safeNextAction: { code: 'repair-code' },
    });
  });

  it('retries only the explicit pre-suite no-verdict allowlist and makes red/code outcomes terminal', () => {
    expect(classifyQualificationVerdict({ reason: 'migrations-pending', green: null })).toEqual({
      kind: 'pre-suite-no-verdict', reason: 'migrations-pending',
    });
    expect(classifyQualificationVerdict({ reason: 'not-green', green: false })).toEqual({ kind: 'red', reason: 'not-green' });
    expect(classifyQualificationVerdict({ reason: 'not-fast-forward', green: null })).toEqual({
      kind: 'code-inconclusive', reason: 'not-fast-forward',
    });

    const red = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1', reason: 'not-green', green: false, nowMs: 400,
    }).transaction;
    expect(red).toMatchObject({ phase: 'terminal', outcome: { kind: 'red' }, currentPhysicalRunner: null });
    expect(waitQualificationTransaction(red, {
      attemptId: 'attempt-1', reason: 'eligibility-wait', nowMs: 500,
    }).status).toBe('terminal');
  });

  it('fails closed on malformed nested metadata instead of trusting a shallow record cast', () => {
    const current = begin();
    expect(parseCheckpointQualificationTransaction(current)).toEqual(current);
    expect(parseCheckpointQualificationTransaction({
      ...current,
      currentPhysicalRunner: {
        id: 'physical-1',
        candidate: null,
        reservedAtMs: 'not-a-number',
        evidenceRefs: [],
      },
    })).toBeNull();
    expect(parseCheckpointQualificationTransaction({
      ...current,
      outcome: { kind: 'pre-suite-no-verdict', reason: 'invented-retry' },
    })).toBeNull();
    expect(parseCheckpointQualificationTransaction({
      ...current,
      phaseDurationsMs: { running: -1 },
    })).toBeNull();
    expect(parseCheckpointQualificationTransaction({
      ...current,
      consumedPhysicalRuns: [{ id: 'run-1', outcome: { kind: 'invented' } }],
    })).toBeNull();
  });

  it('retires only the predecessor-linked safe unstarted queue for a distinct successor', () => {
    const terminal = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1', reason: 'not-green', green: false, nowMs: 400,
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

    expect(
      assessTerminalRepairQueueReconciliation(terminal, successor, safeQueue),
    ).toMatchObject({
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
      attemptId: 'attempt-1', reason: 'not-green', green: false, nowMs: 400,
    }).transaction;
    const redCandidate = markFrozenCandidateVerificationRed(createFrozenCandidateQueue({
      candidate: 'candidate-1',
      qualificationAttemptId: 'attempt-1',
      base: null,
      nowMs: 200,
    }), {
      failingTests: ['broken.test.ts'],
      nowMs: 300,
    });
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

    expect(
      assessTerminalRepairQueueReconciliation(terminal, successor, readyToVerify),
    ).toMatchObject({
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

  // WI-2142947: a NULL qualificationAttemptId (schema v3 permits this, WI-41667) is an
  // ABSENCE of provenance, not evidence of a competing owner. It must not be treated as a
  // permanent 'queue-origin-mismatch' fail-close; it falls through to the same
  // phase/attempts/fixer safety checks as a known-matching origin.
  it('judges a null-origin queue (unknown provenance) on its actual state instead of permanently fail-closing it', () => {
    const terminal = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1', reason: 'not-green', green: false, nowMs: 400,
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
