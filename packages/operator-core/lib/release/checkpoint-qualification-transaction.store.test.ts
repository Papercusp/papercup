import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ boundedOrgTxn: vi.fn() }));

vi.mock('../pg-bounded-txn', () => ({ boundedOrgTxn: h.boundedOrgTxn }));

import {
  beginQualificationTransaction,
  beginStoredQualification,
  cancelStoredQualification,
  reserveQualificationRunner,
  settleQualificationTransaction,
} from './checkpoint-qualification-transaction';
import {
  createFrozenCandidateQueue,
  markFrozenCandidateVerificationRed,
  markFrozenRepairAdmitted,
} from './frozen-candidate-repair-queue';

type QueryResult = Record<string, unknown>[];

const target = { workspaceId: 'workspace-1', installSlug: 'papercusp' };

function terminalQualification() {
  const begun = beginQualificationTransaction(null, {
    attemptId: 'attempt-1',
    requiredAncestorSha: 'old-repair',
    declaredPaths: ['old.ts'],
    candidate: 'candidate-1',
    nowMs: 100,
  }).transaction;
  return settleQualificationTransaction(begun, {
    attemptId: 'attempt-1',
    reason: 'not-green',
    green: false,
    nowMs: 200,
  }).transaction;
}

function terminalSuccessorQualification() {
  const inherited = beginQualificationTransaction(terminalQualification(), {
    attemptId: 'attempt-2',
    requiredAncestorSha: 'repair-1',
    declaredPaths: ['fixed.ts'],
    candidate: 'candidate-1',
    nowMs: 250,
  }).transaction;
  return settleQualificationTransaction(inherited, {
    attemptId: 'attempt-2',
    reason: 'dependency-prewarm-missing',
    nowMs: 275,
  }).transaction;
}

function safeQueue() {
  return createFrozenCandidateQueue({
    candidate: 'candidate-1',
    qualificationAttemptId: 'attempt-1',
    base: null,
    nowMs: 110,
  });
}

function transactionHarness(metadata: Record<string, unknown>, options: { casMatches?: boolean } = {}) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]): Promise<QueryResult> => {
    const text = strings.join('?');
    statements.push({ text, values });
    if (text.includes('SELECT metadata')) return [{ metadata }];
    if (text.includes('UPDATE harness_shared.routines')) {
      return options.casMatches === false ? [] : [{ metadata: {} }];
    }
    throw new Error(`unexpected query: ${text}`);
  }) as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<QueryResult>;
    unsafe(text: string): string;
  };
  tx.unsafe = (text: string) => text;
  h.boundedOrgTxn.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  return { statements };
}

const successor = {
  attemptId: 'attempt-2',
  requiredAncestorSha: 'new-repair',
  declaredPaths: ['new.ts'],
  candidate: 'candidate-2',
  nowMs: 300,
};

beforeEach(() => {
  h.boundedOrgTxn.mockReset();
});

describe('beginStoredQualification terminal repair-queue reconciliation', () => {
  it('atomically clears the exact predecessor queue and repair inconclusive while installing the successor', async () => {
    const current = terminalQualification();
    const queue = safeQueue();
    const { statements } = transactionHarness({
      qualificationTransaction: current,
      repair_queue: queue,
      gate_health: { inconclusive: { status: 'repair-in-progress' }, keep: true },
      unrelated: { preserved: true },
    });

    const result = await beginStoredQualification(target, successor, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });

    expect(result).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-2',
        previousAttemptId: 'attempt-1',
        candidate: 'candidate-2',
      },
      repairQueueReconciliation: {
        status: 'retired',
        reason: 'exact-safe-unstarted',
        predecessorAttemptId: 'attempt-1',
        successorAttemptId: 'attempt-2',
        candidate: 'candidate-1',
      },
    });
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).toContain("- 'repair_queue'");
    expect(update.text).toContain("#- '{gate_health,inconclusive}'");
    expect(update.text).toContain("metadata->'repair_queue' =");
    expect(update.text).toContain('metadata->? =');
    expect(update.values).toContain(JSON.stringify(queue));
    expect(update.values).toContain(JSON.stringify(current));
  });

  it('leaves mismatched or started queues untouched and refuses the successor', async () => {
    const current = terminalQualification();
    for (const queue of [
      { ...safeQueue(), qualificationAttemptId: 'different-attempt' },
      markFrozenCandidateVerificationRed(safeQueue(), {
        failingTests: ['broken.test.ts'],
        nowMs: 150,
      }),
    ]) {
      const { statements } = transactionHarness({
        qualificationTransaction: current,
        repair_queue: queue,
      });
      const result = await beginStoredQualification(target, successor, {
        reconcileTerminalRepairQueueForSuccessor: true,
      });
      expect(result).toMatchObject({ status: 'conflict' });
      expect(statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
    }
  });

  it('installs the successor without deleting a matching untested repair head', async () => {
    const current = terminalQualification();
    const redCandidate = markFrozenCandidateVerificationRed(safeQueue(), {
      failingTests: ['broken.test.ts'],
      nowMs: 150,
    });
    const queue = markFrozenRepairAdmitted(redCandidate, {
      atMs: 175,
      actor: 'agent-1',
      source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1',
      toRepairHead: 'repair-1',
      paths: ['fixed.ts'],
      unchanged: [],
      blobs: { 'fixed.ts': 'blob-1' },
    });
    const { statements } = transactionHarness({
      qualificationTransaction: current,
      repair_queue: queue,
    });

    const result = await beginStoredQualification(target, successor, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });

    expect(result).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-2',
        previousAttemptId: 'attempt-1',
      },
      repairQueueReconciliation: {
        status: 'preserved',
        reason: 'matching-untested-repair-head',
      },
    });
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).not.toContain("- 'repair_queue'");
    expect(update.text).toContain("metadata->'repair_queue' =");
    expect(update.text).toContain("'{repair_queue,qualificationAttemptId}'");
    expect(update.values).toContain(JSON.stringify('attempt-2'));
    expect(update.values).toContain(JSON.stringify(queue));
    expect(update.values).toContain(JSON.stringify(current));
  });

  it('re-stamps an inherited repair head when the predecessor runner is proved dead', async () => {
    const ready = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    const current = reserveQualificationRunner(ready, {
      attemptId: 'attempt-1', runnerId: 'dead-runner', candidate: 'candidate-1',
      leaseDurationMs: 1_000, nowMs: 200,
    }).transaction;
    const red = markFrozenCandidateVerificationRed(safeQueue(), {
      failingTests: ['broken.test.ts'], nowMs: 150,
    });
    const queue = markFrozenRepairAdmitted(red, {
      atMs: 250, actor: 'fixer', source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1', toRepairHead: 'repair-1',
      paths: ['fixed.ts'], unchanged: [], blobs: { 'fixed.ts': 'blob-1' },
    });
    const next = {
      ...successor, candidate: 'repair-1', requiredAncestorSha: 'repair-1',
      incumbentLiveness: 'dead' as const, nowMs: 100_000,
    };
    const { statements } = transactionHarness({ qualificationTransaction: current, repair_queue: queue });

    const result = await beginStoredQualification(target, next, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });
    expect(result).toMatchObject({
      status: 'updated',
      transaction: { attemptId: 'attempt-2', previousAttemptId: 'attempt-1' },
      repairQueueReconciliation: { status: 'preserved', reason: 'matching-untested-repair-head' },
    });
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).toContain("'{repair_queue,qualificationAttemptId}'");
    expect(update.values).toContain(JSON.stringify('attempt-2'));
    expect(update.values).toContain(JSON.stringify(queue));

    const unknown = transactionHarness({ qualificationTransaction: current, repair_queue: queue });
    expect((await beginStoredQualification(target, { ...next, incumbentLiveness: 'unknown' }, {
      reconcileTerminalRepairQueueForSuccessor: true,
    })).status).toBe('conflict');
    expect(unknown.statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
  });

  it('resumes an unowned repair wait on the exact newly admitted head without waiting three hours', async () => {
    const begun = beginQualificationTransaction(null, {
      attemptId: 'attempt-1',
      requiredAncestorSha: 'old-repair',
      declaredPaths: ['old.ts'],
      candidate: 'candidate-1',
      nowMs: 100,
    }).transaction;
    const current = settleQualificationTransaction(begun, {
      attemptId: 'attempt-1',
      reason: 'repair-in-progress',
      nowMs: 200,
    }).transaction;
    const redCandidate = markFrozenCandidateVerificationRed(safeQueue(), {
      failingTests: ['broken.test.ts'],
      nowMs: 150,
    });
    const queue = markFrozenRepairAdmitted(redCandidate, {
      atMs: 175,
      actor: 'agent-1',
      source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1',
      toRepairHead: 'repair-1',
      paths: ['fixed.ts'],
      unchanged: [],
      blobs: { 'fixed.ts': 'blob-1' },
    });
    const { statements } = transactionHarness({
      qualificationTransaction: current,
      repair_queue: queue,
    });

    const result = await beginStoredQualification(
      target,
      {
        ...successor,
        candidate: 'moving-tip',
      },
      { reconcileTerminalRepairQueueForSuccessor: true },
    );

    expect(result).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-1',
        candidate: 'repair-1',
        phase: 'ready',
        outcome: { kind: 'pending' },
        candidatePolicy: { declaredPaths: ['new.ts'] },
        eligibilitySnapshot: null,
      },
    });
    expect(result).not.toHaveProperty('repairQueueReconciliation');
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).not.toContain("'{repair_queue,qualificationAttemptId}'");
    expect(update.values).not.toContain(JSON.stringify(queue));
  });

  it('does not resume a repair wait from a ready queue owned by another qualification', async () => {
    const begun = beginQualificationTransaction(null, {
      attemptId: 'attempt-1',
      candidate: 'candidate-1',
      nowMs: 100,
    }).transaction;
    const current = settleQualificationTransaction(begun, {
      attemptId: 'attempt-1',
      reason: 'repair-in-progress',
      nowMs: 200,
    }).transaction;
    const redCandidate = markFrozenCandidateVerificationRed(safeQueue(), {
      failingTests: ['broken.test.ts'],
      nowMs: 150,
    });
    const queue = {
      ...markFrozenRepairAdmitted(redCandidate, {
        atMs: 175,
        actor: 'agent-1',
        source: { ref: 'staging', sha: 'repair-1' },
        fromRepairHead: 'candidate-1',
        toRepairHead: 'repair-1',
        paths: ['fixed.ts'],
        unchanged: [],
        blobs: { 'fixed.ts': 'blob-1' },
      }),
      qualificationAttemptId: 'different-attempt',
    };
    const { statements } = transactionHarness({
      qualificationTransaction: current,
      repair_queue: queue,
    });

    const result = await beginStoredQualification(target, successor, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });

    expect(result).toMatchObject({ status: 'conflict', transaction: { attemptId: 'attempt-1' } });
    expect(statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
  });

  it('preserves and re-stamps an untested queue owned by the terminal attempt immediate predecessor', async () => {
    const current = terminalSuccessorQualification();
    const redCandidate = markFrozenCandidateVerificationRed(safeQueue(), {
      failingTests: ['broken.test.ts'],
      nowMs: 150,
    });
    const queue = markFrozenRepairAdmitted(redCandidate, {
      atMs: 175,
      actor: 'agent-1',
      source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1',
      toRepairHead: 'repair-1',
      paths: ['fixed.ts'],
      unchanged: [],
      blobs: { 'fixed.ts': 'blob-1' },
    });
    const { statements } = transactionHarness({
      qualificationTransaction: current,
      repair_queue: queue,
    });

    const result = await beginStoredQualification(
      target,
      {
        ...successor,
        attemptId: 'attempt-3',
      },
      {
        reconcileTerminalRepairQueueForSuccessor: true,
      },
    );

    expect(result).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-3',
        previousAttemptId: 'attempt-2',
      },
      repairQueueReconciliation: {
        status: 'preserved',
        reason: 'matching-untested-repair-head',
        predecessorAttemptId: 'attempt-2',
        successorAttemptId: 'attempt-3',
      },
    });
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).not.toContain("- 'repair_queue'");
    expect(update.text).toContain("metadata->'repair_queue' =");
    expect(update.text).toContain("'{repair_queue,qualificationAttemptId}'");
    expect(update.values).toContain(JSON.stringify('attempt-3'));
    expect(update.values).toContain(JSON.stringify(queue));
    expect(update.values).toContain(JSON.stringify(current));
  });

  it('fails closed when the preserved queue changes before its ownership re-stamp', async () => {
    const current = terminalSuccessorQualification();
    const redCandidate = markFrozenCandidateVerificationRed(safeQueue(), {
      failingTests: ['broken.test.ts'],
      nowMs: 150,
    });
    const queue = markFrozenRepairAdmitted(redCandidate, {
      atMs: 175,
      actor: 'agent-1',
      source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1',
      toRepairHead: 'repair-1',
      paths: ['fixed.ts'],
      unchanged: [],
      blobs: { 'fixed.ts': 'blob-1' },
    });
    transactionHarness({ qualificationTransaction: current, repair_queue: queue }, { casMatches: false });

    const result = await beginStoredQualification(
      target,
      {
        ...successor,
        attemptId: 'attempt-3',
      },
      {
        reconcileTerminalRepairQueueForSuccessor: true,
      },
    );

    expect(result).toMatchObject({
      status: 'conflict',
      transaction: { attemptId: 'attempt-2' },
      repairQueueReconciliation: { status: 'blocked', reason: 'cas-miss' },
    });
  });

  it('fails closed on an exact-CAS miss without installing the successor', async () => {
    const current = terminalQualification();
    transactionHarness({ qualificationTransaction: current, repair_queue: safeQueue() }, { casMatches: false });

    const result = await beginStoredQualification(target, successor, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });

    expect(result).toMatchObject({
      status: 'conflict',
      transaction: { attemptId: 'attempt-1' },
      repairQueueReconciliation: { status: 'blocked', reason: 'cas-miss' },
    });
  });

  it('CASes cancellation by attempt and unit, stops before commit, and preserves repair_queue', async () => {
    const begun = beginQualificationTransaction(null, {
      attemptId: 'attempt-1',
      candidate: 'candidate-1',
      nowMs: 100,
    }).transaction;
    const current = reserveQualificationRunner(begun, {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      unit: 'papercup-green-checkpoint-manual-ge93sk.service',
      leaseDurationMs: 1_000,
      nowMs: 200,
    }).transaction;
    const queue = safeQueue();
    const { statements } = transactionHarness({
      qualificationTransaction: current,
      repair_queue: queue,
      unrelated: { preserved: true },
    });
    const stop = vi.fn(async () => ({ stopped: true }));

    const result = await cancelStoredQualification(
      target,
      {
        attemptId: 'attempt-1',
        unit: 'papercup-green-checkpoint-manual-ge93sk.service',
        nowMs: 300,
      },
      stop,
    );

    expect(result).toMatchObject({
      status: 'updated',
      transaction: {
        phase: 'terminal',
        outcome: { kind: 'code-inconclusive', reason: 'cancelled' },
      },
    });
    expect(stop).toHaveBeenCalledTimes(1);
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).toContain("metadata->?->>'attemptId' =");
    expect(update.text).toContain("metadata->?->'currentPhysicalRunner'->>'unit' =");
    expect(update.text).not.toContain("'repair_queue'");
    // The queue is deliberately preserved by omission: cancellation updates only the
    // qualification transaction, so it must not be passed as an UPDATE value at all.
    expect(update.values).not.toContain(JSON.stringify(queue));

    const refused = await cancelStoredQualification(
      target,
      {
        attemptId: 'attempt-1',
        unit: 'other-unit.service',
        nowMs: 301,
      },
      stop,
    );
    expect(refused).toMatchObject({ status: 'conflict' });
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
