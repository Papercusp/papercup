import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ boundedOrgTxn: vi.fn() }));

vi.mock('../pg-bounded-txn', () => ({ boundedOrgTxn: h.boundedOrgTxn }));

import {
  beginQualificationTransaction,
  beginStoredQualification,
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

function safeQueue() {
  return createFrozenCandidateQueue({
    candidate: 'candidate-1',
    qualificationAttemptId: 'attempt-1',
    base: null,
    nowMs: 110,
  });
}

function transactionHarness(
  metadata: Record<string, unknown>,
  options: { casMatches?: boolean } = {},
) {
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
      expect(
        statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines')),
      ).toBe(false);
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
    expect(update.text).not.toContain("metadata->'repair_queue' =");
  });

  it('fails closed on an exact-CAS miss without installing the successor', async () => {
    const current = terminalQualification();
    transactionHarness(
      { qualificationTransaction: current, repair_queue: safeQueue() },
      { casMatches: false },
    );

    const result = await beginStoredQualification(target, successor, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });

    expect(result).toMatchObject({
      status: 'conflict',
      transaction: { attemptId: 'attempt-1' },
      repairQueueReconciliation: { status: 'blocked', reason: 'cas-miss' },
    });
  });
});
