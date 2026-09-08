import { describe, expect, it } from 'vitest';

import type {
  AppendTaskReleaseReceiptResult,
  TaskReleaseJournal,
  TaskReleaseReceipt,
  TaskReleaseReceiptInput,
} from '@papercusp/operator-core/lib/task-manager/store';
import {
  assertReleaseTaskIdentity,
  beginReleaseTaskStage,
  inspectReleaseTaskStage,
  releaseStageInputHash,
  releaseStageRequestIdentity,
  settleReleaseTaskStage,
  type ReleaseTaskLedger,
  type ReleaseTaskStageContext,
} from './release-task-journal';

const SOURCE_SHA = 'a'.repeat(40);
const GITLINK = 'b'.repeat(40);
const OPERATION_ID = 'release-operation-1';
const TASK_ID = 'release-task-1';

function journal(overrides: Partial<TaskReleaseJournal> = {}): TaskReleaseJournal {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    source: { sha: SOURCE_SHA, gitlinks: { 'papercusp-desktop': GITLINK } },
    artifactIdentity: {
      kind: 'papercusp-desktop-release',
      sourceSha: SOURCE_SHA,
      version: '0.0.19-nightly',
      channel: 'nightly',
    },
    cursor: 0,
    currentStage: null,
    currentState: null,
    spentOperationIds: [],
    receipts: [],
    ...overrides,
  };
}

function ledger(initial = journal()): ReleaseTaskLedger & { journal: TaskReleaseJournal } {
  const state = { journal: initial };
  return {
    get journal() {
      return state.journal;
    },
    async getTask(taskId) {
      return taskId === TASK_ID ? { detail: { release: state.journal } } : null;
    },
    taskReleaseJournalFromDetail(detail) {
      return detail?.release === state.journal ? state.journal : null;
    },
    async appendTaskReleaseReceipt(taskId, expectedCursor, input): Promise<AppendTaskReleaseReceiptResult> {
      if (taskId !== TASK_ID) return { ok: false, reason: 'task_not_found', journal: null };
      if (state.journal.cursor !== expectedCursor) {
        return { ok: false, reason: 'cursor_mismatch', journal: state.journal };
      }
      const matching = state.journal.receipts.filter(
        (receipt) => receipt.requestIdentity === input.requestIdentity,
      );
      const prior = matching.at(-1);
      const valid =
        input.state === 'intent'
          ? matching.length === 0
          : input.state === 'unknown'
            ? prior?.state === 'intent'
            : prior?.state === 'intent' || prior?.state === 'unknown';
      if (!valid) return { ok: false, reason: 'invalid_transition', journal: state.journal };
      const receipt: TaskReleaseReceipt = {
        sequence: state.journal.cursor,
        operationId: input.operationId,
        requestIdentity: input.requestIdentity,
        stage: input.stage,
        state: input.state,
        inputHash: input.inputHash,
        evidenceRefs: [...(input.evidenceRefs ?? [])],
        credentialGeneration: input.credentialGeneration ?? null,
        credentialExpiresAt: input.credentialExpiresAt ?? null,
        recordedAt: input.recordedAt ?? new Date(0).toISOString(),
      };
      state.journal.receipts.push(receipt);
      state.journal.cursor += 1;
      state.journal.currentStage = receipt.stage;
      state.journal.currentState = receipt.state;
      if (receipt.state === 'intent') state.journal.spentOperationIds.push(receipt.requestIdentity);
      return { ok: true, journal: state.journal, receipt };
    },
  };
}

function context(store = ledger()): ReleaseTaskStageContext {
  return {
    taskId: TASK_ID,
    operationId: OPERATION_ID,
    ledger: store,
    identity: {
      sourceSha: SOURCE_SHA,
      gitlinks: { 'papercusp-desktop': GITLINK },
      version: '0.0.19-nightly',
      channel: 'nightly',
    },
  };
}

const stage = { stage: 'release.build.linux', identity: 'linux|gui|0.0.19-nightly' };

describe('release task journal identity', () => {
  it('uses canonical stable hashes and attempt-distinct provider-safe request IDs', () => {
    expect(releaseStageInputHash({ b: [2, 3], a: 1 })).toBe(
      releaseStageInputHash({ a: 1, b: [2, 3] }),
    );
    const hash = releaseStageInputHash(stage);
    const first = releaseStageRequestIdentity(OPERATION_ID, stage.stage, hash, 0);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(releaseStageRequestIdentity(OPERATION_ID, stage.stage, hash, 1)).not.toBe(first);
  });

  it('fails closed when source, gitlink, version, or channel identity changes', () => {
    const value = journal();
    expect(() => assertReleaseTaskIdentity(value, context().identity)).not.toThrow();
    expect(() =>
      assertReleaseTaskIdentity(value, { ...context().identity, gitlinks: { 'papercusp-desktop': 'c'.repeat(40) } }),
    ).toThrow(/gitlink tuple/);
    expect(() => assertReleaseTaskIdentity(value, { ...context().identity, version: '0.0.20' })).toThrow(
      /artifact identity/,
    );
  });
});

describe('release task stage transitions', () => {
  it('begins once under a concurrent race and sends the loser to reconciliation', async () => {
    const store = ledger();
    const [left, right] = await Promise.all([
      beginReleaseTaskStage(context(store), stage),
      beginReleaseTaskStage(context(store), stage),
    ]);
    expect([left.action, right.action].sort()).toEqual(['reconcile', 'run']);
    expect(store.journal.receipts).toHaveLength(1);
    expect(store.journal.spentOperationIds).toEqual([left.requestIdentity ?? right.requestIdentity]);
  });

  it('resumes an intent through reconciliation, then reuses committed evidence', async () => {
    const store = ledger();
    const begun = await beginReleaseTaskStage(context(store), stage);
    expect(begun.action).toBe('run');
    const resumed = await beginReleaseTaskStage(context(store), stage);
    expect(resumed).toMatchObject({ action: 'reconcile', state: 'intent' });
    await settleReleaseTaskStage(context(store), {
      ...stage,
      requestIdentity: begun.requestIdentity!,
      state: 'committed',
      evidenceRefs: ['artifact:sha256:123'],
    });
    await expect(beginReleaseTaskStage(context(store), stage)).resolves.toMatchObject({
      action: 'reuse',
      state: 'committed',
    });
  });

  it('records confirmed absence before minting a new one-use attempt', async () => {
    const store = ledger();
    const first = await beginReleaseTaskStage(context(store), stage);
    await settleReleaseTaskStage(context(store), {
      ...stage,
      requestIdentity: first.requestIdentity!,
      state: 'unknown',
      evidenceRefs: ['process:interrupted'],
    });
    await settleReleaseTaskStage(context(store), {
      ...stage,
      requestIdentity: first.requestIdentity!,
      state: 'refused',
      evidenceRefs: ['reconcile:confirmed-absent'],
    });
    const retry = await beginReleaseTaskStage(context(store), stage);
    expect(retry.action).toBe('run');
    expect(retry.requestIdentity).not.toBe(first.requestIdentity);
    expect(store.journal.spentOperationIds).toHaveLength(2);
  });

  it('refuses changed stage inputs and a mismatched settle request', async () => {
    const store = ledger();
    const first = await beginReleaseTaskStage(context(store), stage);
    await expect(
      inspectReleaseTaskStage(context(store), { ...stage, identity: 'linux|server|0.0.19-nightly' }),
    ).rejects.toThrow(/input changed/);
    await expect(
      settleReleaseTaskStage(context(store), {
        ...stage,
        requestIdentity: 'wrong-request',
        state: 'committed',
      }),
    ).rejects.toThrow(/does not match/);
    expect(first.action).toBe('run');
  });
});
