import { describe, expect, it } from 'vitest';
import {
  assessTerminalRepairQueueReconciliation,
  beginQualificationTransaction,
  classifyQualificationVerdict,
  parseCheckpointQualificationTransaction,
  qualificationIntentMatches,
  reserveQualificationRunner,
  settleQualificationTransaction,
  waitQualificationTransaction,
} from './checkpoint-qualification-transaction';
import {
  createFrozenCandidateQueue,
  markFrozenCandidateVerificationRed,
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
      nowMs: 300,
    }).transaction;
    expect(running).toMatchObject({ phase: 'running', currentPhysicalRunner: { id: 'physical-1' } });
    expect(reserveQualificationRunner(running, { attemptId: 'attempt-1', runnerId: 'physical-1' }).status).toBe('idempotent');
    expect(reserveQualificationRunner(running, { attemptId: 'attempt-1', runnerId: 'physical-2' }).status).toBe('conflict');
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
  });

  it('retires only the predecessor-linked safe unstarted queue for a distinct successor', () => {
    const terminal = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1', reason: 'not-green', green: false, nowMs: 400,
    }).transaction;
    const safeQueue = createFrozenCandidateQueue({
      candidate: 'candidate-1',
      qualificationAttemptId: 'attempt-1',
      base: null,
      worktreePath: '/repo/.papercusp/worktrees/candidate-1',
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
    expect(
      assessTerminalRepairQueueReconciliation(terminal, successor, {
        ...safeQueue,
        qualificationAttemptId: undefined,
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-mismatch' });
  });
});
