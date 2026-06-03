/**
 * Unit tests for the backup DBOS workflow's PURE pieces (plan
 * dbos-durable-flows-adoption P-011): the per-request workflowID, the
 * `DBOS.isInWorkflow()` guard on the injected StepRunner, the injectable
 * executor, and the synchronous request→result contract. The live DBOS
 * durable-result / resume mechanics are proven separately in
 * backup-workflow.integration.test.ts.
 *
 * The DBOS SDK is mocked (as in provision-workflow.test.ts) so importing the
 * module needs no launched DBOS: `runStep` records its name + runs the thunk,
 * `isInWorkflow` is controllable, `registerWorkflow` returns the impl, and
 * `startWorkflow` resolves a handle whose `getResult` runs the workflow.
 * `@papercusp/backup` is mocked so we capture the injected runner without the
 * real lib.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({ inWorkflow: false }));
const dbosCalls = vi.hoisted(() => ({ steps: [] as string[] }));
const captured = vi.hoisted(
  () => ({ runner: null as null | { runStep: (n: string, fn: () => Promise<unknown>) => Promise<unknown> } }),
);

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    isInWorkflow: () => ctl.inWorkflow,
    runStep: (fn: () => unknown, cfg?: { name?: string }) => {
      dbosCalls.steps.push(cfg?.name ?? '');
      return fn();
    },
    registerWorkflow: (impl: unknown) => impl,
    startWorkflow:
      (wf: (args: unknown) => Promise<unknown>) =>
      (args: unknown) =>
        Promise.resolve({ getResult: () => wf(args) }),
  },
}));

vi.mock('@papercusp/backup', () => ({
  configureBackupStepRunner: (r: unknown) => {
    captured.runner = r as typeof captured.runner;
  },
  workspaceBackupFor: () => ({
    snapshot: async () => ({ snapshotId: 99, kopiaSnapshotId: 'kopia-default', bytesAdded: 1, durationMs: 1 }),
  }),
}));

import {
  backupSnapshotWorkflowId,
  wireBackupStepRunner,
  startBackupSnapshotWorkflow,
  setBackupSnapshotExecutor,
  startBackupRestoreInPlaceWorkflow,
  startBackupPromoteWorkflow,
  startBackupRollbackWorkflow,
  setRestoreInPlaceExecutor,
  setPromoteExecutor,
  setRollbackExecutor,
} from './backup-workflow';

afterEach(() => {
  ctl.inWorkflow = false;
  dbosCalls.steps.length = 0;
  captured.runner = null;
  setBackupSnapshotExecutor(null);
  setRestoreInPlaceExecutor(null);
  setPromoteExecutor(null);
  setRollbackExecutor(null);
  vi.restoreAllMocks();
});

describe('backupSnapshotWorkflowId', () => {
  it('is the (workspace, reason) target + per-request nonce — a unique resume key', () => {
    const a = backupSnapshotWorkflowId({ workspaceId: 'ws-1', reason: 'manual' }, 'n1');
    const b = backupSnapshotWorkflowId({ workspaceId: 'ws-1', reason: 'manual' }, 'n2');
    expect(a).toBe('backup-snapshot:ws-1:manual:n1');
    // Different request → distinct id → each is independently resumable.
    expect(a).not.toBe(b);
  });
});

describe('wireBackupStepRunner — DBOS.isInWorkflow() guard', () => {
  it('checkpoints via DBOS.runStep when inside a workflow', async () => {
    wireBackupStepRunner();
    ctl.inWorkflow = true;
    const out = await captured.runner!.runStep('phase-1', async () => 'val');
    expect(out).toBe('val');
    expect(dbosCalls.steps).toEqual(['phase-1']);
  });

  it('passes through (never touches DBOS.runStep) when NOT inside a workflow', async () => {
    wireBackupStepRunner();
    ctl.inWorkflow = false;
    const out = await captured.runner!.runStep('phase-1', async () => 'val');
    expect(out).toBe('val');
    expect(dbosCalls.steps).toEqual([]);
  });
});

describe('startBackupSnapshotWorkflow', () => {
  it('awaits the durable result + forwards args to the executor (sync contract preserved)', async () => {
    const stub = { snapshotId: 7, kopiaSnapshotId: 'kopia-stub', bytesAdded: 5, durationMs: 2 };
    const seen: Array<{ ws: string; reason: string; context: unknown }> = [];
    setBackupSnapshotExecutor(async (ws, reason, context) => {
      seen.push({ ws, reason, context });
      return stub;
    });
    const r = await startBackupSnapshotWorkflow(
      { workspaceId: 'ws-1', reason: 'manual', context: { note: 'x' } },
      'n1',
    );
    expect(r).toEqual(stub);
    expect(seen).toEqual([{ ws: 'ws-1', reason: 'manual', context: { note: 'x' } }]);
  });

  it('falls back to the real per-workspace snapshot when no executor is injected', async () => {
    const r = await startBackupSnapshotWorkflow({ workspaceId: 'ws-1', reason: 'manual' }, 'n1');
    expect(r.kopiaSnapshotId).toBe('kopia-default');
  });
});

describe('destructive trio workflows (P-012)', () => {
  it('startBackupPromoteWorkflow threads the nonce as opId to the executor', async () => {
    const seen: unknown[] = [];
    setPromoteExecutor(async (i) => {
      seen.push(i);
      return { broken: '/b', live: '/l' };
    });
    const r = await startBackupPromoteWorkflow(
      { workspaceId: 'ws', restoredPath: '/r', liveTarget: '/l' },
      'nonce-X',
    );
    // opId MUST equal the nonce → deterministic broken-dir name across a resume.
    expect(seen[0]).toEqual({ workspaceId: 'ws', restoredPath: '/r', liveTarget: '/l', opId: 'nonce-X' });
    expect(r).toEqual({ broken: '/b', live: '/l' });
  });

  it('startBackupRollbackWorkflow threads the nonce as opId to the executor', async () => {
    const seen: unknown[] = [];
    setRollbackExecutor(async (i) => {
      seen.push(i);
      return { liveBefore: '/s', liveAfter: '/l' };
    });
    await startBackupRollbackWorkflow({ workspaceId: 'ws', brokenPath: '/b' }, 'nonce-Y');
    expect(seen[0]).toEqual({ workspaceId: 'ws', brokenPath: '/b', opId: 'nonce-Y' });
  });

  it('startBackupRestoreInPlaceWorkflow forwards args + awaits the durable result', async () => {
    setRestoreInPlaceExecutor(async () => ({ targetPath: '/t', prevSnapshotId: 'p' }));
    const r = await startBackupRestoreInPlaceWorkflow({ workspaceId: 'ws', kopiaSnapshotId: 'k' }, 'nonce-Z');
    expect(r).toEqual({ targetPath: '/t', prevSnapshotId: 'p' });
  });
});
