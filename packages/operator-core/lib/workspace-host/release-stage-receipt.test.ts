import { describe, expect, it } from 'vitest';

import {
  releaseTaskStageInputHash,
  type ReleaseTaskLedger,
} from '../../../../scripts/lib/release-task-journal';
import type {
  AppendTaskReleaseReceiptResult,
  TaskReleaseJournal,
  TaskReleaseReceipt,
} from '../task-manager/store';
import {
  WORKSPACE_HOST_RELEASE_CHANNEL,
  WorkspaceHostReleaseBindingError,
  assertWorkspaceHostReleaseStageWritable,
  beginWorkspaceHostReleaseStage,
  releaseJournalBundleDigests,
  resolveWorkspaceHostReleaseBinding,
  settleWorkspaceHostReleaseStage,
  workspaceHostReleaseStageContext,
  type WorkspaceHostReleaseStage,
} from './release-stage-receipt';

const TASK_ID = 'release-task-1';
const OPERATION_ID = 'release-operation-1';
const SOURCE_SHA = 'a'.repeat(40);
const GITLINKS = { 'papercusp-desktop': 'b'.repeat(40) };
const BUNDLE = 'c'.repeat(64);
const OTHER_BUNDLE = 'd'.repeat(64);
const STAGE: WorkspaceHostReleaseStage = { stage: 'workspace.root-bootstrap', identity: { contract: 1 } };

function receipt(stage: string, state: TaskReleaseReceipt['state'], evidenceRefs: string[], sequence: number): TaskReleaseReceipt {
  return {
    sequence,
    operationId: OPERATION_ID,
    requestIdentity: `request-${sequence}`,
    stage,
    state,
    inputHash: 'e'.repeat(64),
    inputIdentity: null,
    evidenceRefs,
    credentialGeneration: null,
    credentialExpiresAt: null,
    reuseSource: null,
    lookupElapsedMs: null,
    queueWaitMs: null,
    preparationElapsedMs: null,
    reuseExpiresAt: null,
    recordedAt: new Date(0).toISOString(),
  };
}

/** A publication-only task (how r37 was published): the digest is pinned in the artifact identity. */
function digestJournal(receipts: TaskReleaseReceipt[] = []): TaskReleaseJournal {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    source: { sha: SOURCE_SHA, gitlinks: { ...GITLINKS } },
    artifactIdentity: { bundleSha256: BUNDLE },
    cursor: receipts.length,
    currentStage: receipts.at(-1)?.stage ?? null,
    currentState: receipts.at(-1)?.state ?? null,
    spentOperationIds: receipts.filter((entry) => entry.state === 'intent').map((entry) => entry.requestIdentity),
    receipts,
  };
}

/** A managed cut (D-394): seeded with a LABEL identity before its build; the build receipt names the digest. */
function labelJournal(receipts: TaskReleaseReceipt[]): TaskReleaseJournal {
  return {
    ...digestJournal(receipts),
    artifactIdentity: {
      kind: 'papercusp-workspace-host-release',
      sourceSha: SOURCE_SHA,
      version: '0.0.21-p318',
      channel: 'workspace-host-stable',
    },
  };
}

const BUILT = [
  receipt('release.build.workspace-host-linux-x86_64', 'intent', [], 0),
  receipt('release.build.workspace-host-linux-x86_64', 'committed', [`bundle:sha256:${BUNDLE}`], 1),
];

function ledger(initial: TaskReleaseJournal): ReleaseTaskLedger & { journal: TaskReleaseJournal } {
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
      if (state.journal.cursor !== expectedCursor) return { ok: false, reason: 'cursor_mismatch', journal: state.journal };
      const prior = state.journal.receipts.filter((entry) => entry.requestIdentity === input.requestIdentity).at(-1);
      const valid = input.state === 'intent' ? !prior : prior?.state === 'intent' || prior?.state === 'unknown';
      if (!valid) return { ok: false, reason: 'invalid_transition', journal: state.journal };
      const appended: TaskReleaseReceipt = {
        ...receipt(input.stage, input.state, [...(input.evidenceRefs ?? [])], state.journal.cursor),
        requestIdentity: input.requestIdentity,
        inputHash: input.inputHash,
        inputIdentity: input.inputIdentity ?? null,
      };
      state.journal.receipts.push(appended);
      state.journal.cursor += 1;
      state.journal.currentStage = appended.stage;
      state.journal.currentState = appended.state;
      if (appended.state === 'intent') state.journal.spentOperationIds.push(appended.requestIdentity);
      return { ok: true, journal: state.journal, receipt: appended };
    },
  };
}

async function bindingError(promise: Promise<unknown>): Promise<WorkspaceHostReleaseBindingError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WorkspaceHostReleaseBindingError);
  return error as WorkspaceHostReleaseBindingError;
}

describe('resolveWorkspaceHostReleaseBinding', () => {
  it('binds a digest-identified task exactly as the pre-D-394 soak binding did', async () => {
    const store = ledger(digestJournal());
    const binding = await resolveWorkspaceHostReleaseBinding({
      releaseTaskId: TASK_ID,
      stage: STAGE.stage,
      hostRuntimeRelease: { bundleSha256: BUNDLE, version: '0.0.20-p318r37' },
      ledger: store,
    });
    expect(binding).toEqual({
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      bundleSha256: BUNDLE,
      sourceSha: SOURCE_SHA,
      gitlinks: GITLINKS,
      version: '0.0.20-p318r37',
    });
  });

  // A running soak holds its binding as DBOS workflow input and settles at the end by re-deriving
  // the request's input hash. That derivation must not move under it, or the soak can never settle
  // the intent it recorded a day earlier.
  it('keeps the stage input hash a persisted (pre-D-394) soak binding recorded its intent under', () => {
    const persisted = {
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      bundleSha256: BUNDLE,
      sourceSha: SOURCE_SHA,
      gitlinks: GITLINKS,
      version: '0.0.20-p318r37',
    };
    const policy = { durationMs: 86_400_000, intervalMs: 300_000 };
    const before = releaseTaskStageInputHash(
      {
        identity: {
          sourceSha: SOURCE_SHA,
          gitlinks: GITLINKS,
          version: '0.0.20-p318r37',
          channel: 'workspace-host',
          bundleSha256: BUNDLE,
        },
      },
      { stage: 'acceptance.soak-24h', sourceScope: 'stage', identity: { bundleSha256: BUNDLE, policy } },
    );
    const after = releaseTaskStageInputHash(workspaceHostReleaseStageContext(persisted, ledger(digestJournal())), {
      stage: 'acceptance.soak-24h',
      sourceScope: 'stage',
      identity: { policy, bundleSha256: BUNDLE },
    });
    expect(WORKSPACE_HOST_RELEASE_CHANNEL).toBe('workspace-host');
    expect(after).toBe(before);
  });

  it('binds a managed cut by the digest its committed build receipt names, under its label identity', async () => {
    const store = ledger(labelJournal(BUILT));
    const binding = await resolveWorkspaceHostReleaseBinding({
      releaseTaskId: TASK_ID,
      stage: STAGE.stage,
      hostRuntimeRelease: { bundleSha256: BUNDLE, version: 'ignored-for-a-label-identity' },
      ledger: store,
    });
    expect(binding.bundleSha256).toBe(BUNDLE);
    expect(binding.version).toBe('0.0.21-p318');
    expect(binding.artifactLabel).toEqual({ channel: 'workspace-host-stable' });
  });

  it('refuses a managed cut whose build never committed: an intent names no bytes', async () => {
    const store = ledger(labelJournal([receipt('release.build.workspace-host-linux-x86_64', 'intent', [`bundle:sha256:${BUNDLE}`], 0)]));
    const error = await bindingError(
      resolveWorkspaceHostReleaseBinding({ releaseTaskId: TASK_ID, stage: STAGE.stage, hostRuntimeRelease: { bundleSha256: BUNDLE }, ledger: store }),
    );
    expect(error.reason).toBe('bundle-unrecorded');
    expect(error.message).toContain('Cannot record workspace.root-bootstrap');
  });

  it('refuses a journal that names two different bundles', async () => {
    const store = ledger(digestJournal([receipt('publish.finalize', 'committed', [`provider:bundle:${OTHER_BUNDLE}`], 0)]));
    const error = await bindingError(
      resolveWorkspaceHostReleaseBinding({ releaseTaskId: TASK_ID, stage: STAGE.stage, hostRuntimeRelease: { bundleSha256: BUNDLE }, ledger: store }),
    );
    expect(error.reason).toBe('bundle-ambiguous');
  });

  it('refuses a host that runs other bytes', async () => {
    const error = await bindingError(
      resolveWorkspaceHostReleaseBinding({
        releaseTaskId: TASK_ID,
        stage: STAGE.stage,
        hostRuntimeRelease: { bundleSha256: OTHER_BUNDLE },
        ledger: ledger(digestJournal()),
      }),
    );
    expect(error.reason).toBe('bundle-mismatch');
  });

  it('refuses an unknown task and a label journal with no version or channel', async () => {
    const missing = await bindingError(
      resolveWorkspaceHostReleaseBinding({ releaseTaskId: 'nope', stage: STAGE.stage, hostRuntimeRelease: {}, ledger: ledger(digestJournal()) }),
    );
    expect(missing.reason).toBe('task-not-found');
    const unlabelled = ledger({ ...labelJournal(BUILT), artifactIdentity: { kind: 'papercusp-workspace-host-release' } });
    const error = await bindingError(
      resolveWorkspaceHostReleaseBinding({ releaseTaskId: TASK_ID, stage: STAGE.stage, hostRuntimeRelease: { bundleSha256: BUNDLE }, ledger: unlabelled }),
    );
    expect(error.reason).toBe('artifact-unidentified');
  });
});

describe('releaseJournalBundleDigests', () => {
  it('reads only committed build and publication receipts', () => {
    const journal = labelJournal([
      receipt('release.build.workspace-host-linux-x86_64', 'refused', [`bundle:sha256:${OTHER_BUNDLE}`], 0),
      receipt('acceptance.soak-24h', 'committed', [`bundle:sha256:${OTHER_BUNDLE}`], 1),
      receipt('publish.finalize', 'committed', [`provider:bundle:${BUNDLE}`, `artifact:sha256:${OTHER_BUNDLE}:295`], 2),
    ]);
    expect(releaseJournalBundleDigests(journal)).toEqual([BUNDLE]);
  });
});

describe('workspace-host release stage writer', () => {
  it('records a managed cut stage end to end and then refuses to record it twice', async () => {
    const store = ledger(labelJournal(BUILT));
    const binding = await resolveWorkspaceHostReleaseBinding({
      releaseTaskId: TASK_ID,
      stage: STAGE.stage,
      hostRuntimeRelease: { bundleSha256: BUNDLE },
      ledger: store,
    });
    await assertWorkspaceHostReleaseStageWritable(binding, STAGE, store);
    const begun = await beginWorkspaceHostReleaseStage(binding, STAGE, store);
    expect(begun.adopted).toBe(false);
    await settleWorkspaceHostReleaseStage({
      binding,
      stage: STAGE,
      requestIdentity: begun.requestIdentity,
      outcome: 'committed',
      evidenceRefs: ['host:ws-1/host-1'],
      ledger: store,
    });
    const committed = store.journal.receipts.at(-1)!;
    expect(committed).toMatchObject({ stage: STAGE.stage, state: 'committed', evidenceRefs: ['host:ws-1/host-1'] });

    const again = await bindingError(assertWorkspaceHostReleaseStageWritable(binding, STAGE, store));
    expect(again.reason).toBe('stage-committed');
  });

  it('settles a failed outcome refused-and-retryable, so the next attempt mints a fresh request', async () => {
    const store = ledger(digestJournal());
    const binding = await resolveWorkspaceHostReleaseBinding({
      releaseTaskId: TASK_ID,
      stage: STAGE.stage,
      hostRuntimeRelease: { bundleSha256: BUNDLE, version: 'v' },
      ledger: store,
    });
    const first = await beginWorkspaceHostReleaseStage(binding, STAGE, store);
    await settleWorkspaceHostReleaseStage({
      binding,
      stage: STAGE,
      requestIdentity: first.requestIdentity,
      outcome: 'refused',
      evidenceRefs: ['host:ws-1/host-1'],
      ledger: store,
    });
    expect(store.journal.receipts.at(-1)).toMatchObject({
      state: 'refused',
      evidenceRefs: ['reconcile:confirmed-absent', 'host:ws-1/host-1'],
    });
    const second = await beginWorkspaceHostReleaseStage(binding, STAGE, store);
    expect(second.requestIdentity).not.toBe(first.requestIdentity);
  });
});
