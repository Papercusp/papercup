import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ boundedOrgTxn: vi.fn() }));

vi.mock('../pg-bounded-txn', () => ({ boundedOrgTxn: h.boundedOrgTxn }));

import {
  beginQualificationTransaction,
  beginStoredQualification,
  cancelStoredQualification,
  reserveQualificationRunner,
  reserveStoredQualificationRunner,
  retargetPreSuiteAttemptToOwningRepairHead,
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

  it('rebinds only a dead unstarted runner to its same-row pending repair head', async () => {
    const begun = beginQualificationTransaction(null, {
      attemptId: 'attempt-1',
      candidate: 'candidate-1',
      nowMs: 100,
    }).transaction;
    const reserved = reserveQualificationRunner(begun, {
      attemptId: 'attempt-1',
      runnerId: 'gate-fire-old',
      candidate: 'candidate-1',
      unit: 'papercup-checkpoint-gate-fire-old.scope',
      leaseDurationMs: 10_000,
      started: false,
      evidenceRefs: ['gate-fire:gate-fire-old'],
      nowMs: 200,
    }).transaction;
    const current = {
      ...reserved,
      pendingRepairHead: 'repair-1',
    };
    const red = markFrozenCandidateVerificationRed(safeQueue(), {
      failingTests: ['broken.test.ts'],
      nowMs: 150,
    });
    const queue = markFrozenRepairAdmitted(red, {
      atMs: 250,
      actor: 'fixer',
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
    const result = await beginStoredQualification(target, {
      attemptId: 'attempt-1',
      candidate: 'candidate-1',
      incumbentLiveness: 'dead',
      nowMs: 100_000,
    });

    expect(result).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-1',
        candidate: 'repair-1',
        repairHead: 'repair-1',
        pendingRepairHead: null,
        phase: 'ready',
        outcome: { kind: 'pending' },
        runId: null,
        lastProgressAtMs: 100_000,
        currentPhysicalRunner: null,
        consumedPhysicalRuns: [expect.objectContaining({
          id: 'gate-fire-old',
          candidate: 'candidate-1',
          outcome: { kind: 'pre-suite-no-verdict', reason: 'runner-vanished' },
        })],
        eligibilitySnapshot: null,
      },
    });
    if (result.status !== 'updated') throw new Error('expected repair-head rebind to update the transaction');
    const read = statements.find((statement) => statement.text.includes('SELECT metadata'))!;
    expect(read.text).toContain('FOR UPDATE');
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.values).toContain('qualificationTransaction');
    expect(update.values).toContain(JSON.stringify(result.transaction));

    for (const incumbentLiveness of ['live', 'unknown'] as const) {
      const guarded = transactionHarness({ qualificationTransaction: current, repair_queue: queue });
      const unchanged = await beginStoredQualification(target, {
        attemptId: 'attempt-1',
        candidate: 'candidate-1',
        incumbentLiveness,
        nowMs: 100_000,
      });
      expect(unchanged).toMatchObject({
        status: 'idempotent',
        transaction: { candidate: 'candidate-1', currentPhysicalRunner: { id: 'gate-fire-old' } },
      });
      expect(guarded.statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines')))
        .toBe(false);
    }

    const attached = reserveQualificationRunner(begun, {
      attemptId: 'attempt-1',
      runnerId: 'gate-fire-old',
      runId: 'run-1',
      candidate: 'candidate-1',
      pid: 123,
      pidIdentity: 'boot:123',
      leaseDurationMs: 10_000,
      started: true,
      evidenceRefs: ['gate-fire:gate-fire-old', 'checkpoint-run:run-1'],
      nowMs: 250,
    }).transaction;
    const attachedCurrent = { ...attached, pendingRepairHead: 'repair-1' };
    const attachedHarness = transactionHarness({
      qualificationTransaction: attachedCurrent,
      repair_queue: queue,
    });
    const attachedResult = await beginStoredQualification(target, {
      attemptId: 'attempt-1',
      candidate: 'candidate-1',
      incumbentLiveness: 'dead',
      nowMs: 100_000,
    });
    expect(attachedResult).toMatchObject({
      status: 'idempotent',
      transaction: { candidate: 'candidate-1', currentPhysicalRunner: { pid: 123 } },
    });
    expect(attachedHarness.statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines')))
      .toBe(false);
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

describe('reserveStoredQualificationRunner pre-suite retarget (WI-10005957)', () => {
  type Transaction = ReturnType<typeof beginQualificationTransaction>['transaction'];

  // The measured wedge: an earlier fire tore before its candidate resolved and settled the
  // attempt onto the integration tip; the next fire reserved its own placeholder on that tip.
  function wedgedAttempt(overrides: Partial<Transaction> = {}): Transaction {
    const begun = beginQualificationTransaction(null, { attemptId: 'attempt-1', nowMs: 100 }).transaction;
    return {
      ...begun,
      phase: 'running',
      candidate: 'tip-sha',
      repairHead: null,
      runId: null,
      outcome: { kind: 'pending' },
      consumedPhysicalRuns: [{
        id: 'fire-1', unit: 'fire-1.scope', phase: 'launching', pid: null, pidIdentity: null, candidate: null,
        evidenceRefs: ['gate-fire:fire-1', 'checkpoint-run:run-1'],
        reservedAtMs: 110, heartbeatAtMs: 110, leaseExpiresAtMs: 10_000,
        outcome: { kind: 'pre-suite-no-verdict', reason: 'infra-inconclusive' }, endedAtMs: 150,
      }],
      currentPhysicalRunner: {
        id: 'fire-2', unit: 'fire-2.scope', phase: 'launching', pid: null, pidIdentity: null, candidate: 'tip-sha',
        evidenceRefs: ['gate-fire:fire-2'], reservedAtMs: 200, heartbeatAtMs: 200, leaseExpiresAtMs: 100_000,
      },
      ...overrides,
    };
  }

  function owningQueue() {
    const red = markFrozenCandidateVerificationRed(safeQueue(), { failingTests: ['broken.test.ts'], nowMs: 150 });
    return markFrozenRepairAdmitted(red, {
      atMs: 175, actor: 'fixer', source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1', toRepairHead: 'repair-1',
      paths: ['fixed.ts'], unchanged: [], blobs: { 'fixed.ts': 'blob-1' },
    });
  }

  const attach = {
    attemptId: 'attempt-1', runnerId: 'fire-2', runId: 'run-2', candidate: 'repair-1', pid: 4242,
    leaseDurationMs: 1_000, started: true, evidenceRefs: ['checkpoint-run:run-2'],
    incumbentLiveness: 'unknown' as const, nowMs: 300,
  };

  it('attaches the CLI to the owning queue\'s never-judged repair head instead of refusing conflict', async () => {
    const queue = owningQueue();
    expect(queue).toMatchObject({ phase: 'ready-to-verify', qualificationAttemptId: 'attempt-1', repairHead: 'repair-1' });
    const { statements } = transactionHarness({ qualificationTransaction: wedgedAttempt(), repair_queue: queue });

    const result = await reserveStoredQualificationRunner(target, attach);

    expect(result).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-1',
        candidate: 'repair-1',
        repairHead: 'repair-1',
        runId: 'run-2',
        currentPhysicalRunner: { id: 'fire-2', candidate: 'repair-1', pid: 4242, phase: 'materializing' },
      },
    });
    const stored = (result as { transaction: Transaction }).transaction;
    expect(stored.evidenceRefs).toEqual(expect.arrayContaining(['candidate:repair-1', 'retargeted-from:tip-sha']));
    expect(statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines'))).toBe(true);
  });

  it('keeps failing closed whenever the same row does not prove the queue owns an unjudged head', async () => {
    const queue = owningQueue();
    const unadmitted = markFrozenCandidateVerificationRed(safeQueue(), { failingTests: ['broken.test.ts'], nowMs: 150 });
    const cases: Array<{ name: string; transaction: Transaction; queue: unknown; candidate: string }> = [
      { name: 'queue owned by another attempt', transaction: wedgedAttempt(),
        queue: { ...queue, qualificationAttemptId: 'attempt-other' }, candidate: 'repair-1' },
      { name: 'CLI asks for a sha that is not the queue head', transaction: wedgedAttempt(), queue, candidate: 'other-sha' },
      { name: 'queue head equals the frozen candidate (nothing to verify)', transaction: wedgedAttempt(),
        queue: unadmitted, candidate: 'candidate-1' },
      { name: 'a fixer is dispatched', transaction: wedgedAttempt(), queue: { ...queue, fixerSpawnId: 'spawn-1' }, candidate: 'repair-1' },
      { name: 'a suite already judged under this attempt', candidate: 'repair-1', queue,
        transaction: wedgedAttempt({
          consumedPhysicalRuns: [{
            ...wedgedAttempt().consumedPhysicalRuns![0]!, outcome: { kind: 'red', reason: 'not-green' },
          }],
        }) },
      { name: 'the placeholder already attached a process', candidate: 'repair-1', queue,
        transaction: wedgedAttempt({
          currentPhysicalRunner: { ...wedgedAttempt().currentPhysicalRunner!, phase: 'materializing', pid: 99 },
        }) },
      { name: 'no queue at all', transaction: wedgedAttempt(), queue: null, candidate: 'repair-1' },
    ];
    for (const testCase of cases) {
      const { statements } = transactionHarness({ qualificationTransaction: testCase.transaction, repair_queue: testCase.queue });
      const result = await reserveStoredQualificationRunner(target, { ...attach, candidate: testCase.candidate });
      expect({ name: testCase.name, status: result.status }).toEqual({ name: testCase.name, status: 'conflict' });
      expect(statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
    }
  });

  it('is the identity when the stored candidate already matches or the caller is a reservation, not an attach', () => {
    const current = wedgedAttempt();
    const queue = owningQueue();
    expect(retargetPreSuiteAttemptToOwningRepairHead(current, { ...attach, started: false }, queue)).toBe(current);
    const aligned = wedgedAttempt({ candidate: 'repair-1' });
    expect(retargetPreSuiteAttemptToOwningRepairHead(aligned, attach, queue)).toBe(aligned);
  });
});
