/**
 * CAP-CONTRACT-P003-PTY-RESIZE integration proof.
 *
 * The model-facing adapter, durable task-id authorization, real node-pty handle,
 * kernel TTY geometry, and screen read all participate. Only the task ledger and
 * resource-governor persistence edges are test doubles; replacing resizePty with
 * a response-only implementation leaves `stty size` unchanged and fails.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';

const mocks = vi.hoisted(() => {
  const state = {
    task: null as Record<string, any> | null,
    enrolment: null as Record<string, any> | null,
  };
  const finishSyncEnrolment = vi.fn((_enrolment: unknown, outcome: Record<string, unknown>) => {
    if (state.task) state.task = { ...state.task, ...outcome };
  });
  return { state, finishSyncEnrolment };
});

vi.mock('../../task-manager/enroll-sync', () => ({
  beginSyncEnrolment: () => {
    const enrolment = {
      taskId: 'mptyresize0001',
      confined: true,
      unconfinedReason: null,
      unitKind: 'scope',
      scopeUnit: 'pc-mptyresize0001.scope',
      enrolled: true,
      registrationReady: null as Promise<void> | null,
      releaseEnvironmentTransport: () => {},
      wrap: (binary: string, argv: string[]) => ({ binary, argv }),
    };
    mocks.state.enrolment = enrolment;
    return enrolment;
  },
  completeSyncEnrolment: (enrolment: Record<string, any>, spec: Record<string, any>, pid: number, opts: Record<string, any>) => {
    mocks.state.task = {
      taskId: enrolment.taskId,
      class: spec.class,
      workspaceId: opts.workspaceId,
      harnessSlug: spec.harnessSlug,
      launchedBy: spec.launchedBy,
      detail: spec.detail,
      pid,
      state: 'running',
      exitCode: null,
      exitReason: null,
    };
    enrolment.registrationReady = Promise.resolve();
  },
  finishSyncEnrolment: mocks.finishSyncEnrolment,
  syncEnrolmentScopePath: () => '/user.slice/papercusp-pty.slice/pc-mptyresize0001.scope',
}));
vi.mock('../../task-manager/store', () => ({ getTask: async () => mocks.state.task }));
vi.mock('../../resource-governor/execution', () => ({
  governedExecutionRuntime: () => ({ governor: {}, driver: {} }),
  beginGovernedExecution: async () => ({
    context: {
      contractVersion: 1,
      requestId: 'pty-resize-request',
      rootRequestId: 'pty-resize-request',
      parentRequestId: null,
      parentReceiptId: null,
      receiptId: 'pty-resize-receipt',
      idempotencyKey: 'pty-resize-test',
      admissionClass: 'process',
      priority: 0,
      demand: { cpuWeight: 1 },
      depth: 0,
      createdAtMs: 1,
      decisionGeneration: 1,
      leaseId: 'pty-resize-lease',
    },
    finish: async () => true,
    cancel: async () => true,
  }),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: (ctx: { uiClientId: string; workspaceId: string }) => ({
    ownerId: ctx.uiClientId,
    ownerLabel: ctx.uiClientId,
    source: 'test',
    workspaceId: ctx.workspaceId,
    userId: null,
  }),
}));
vi.mock('../_harness-scope', () => ({
  resolveConcreteHarnessSlug: (_arg: unknown, ctx: { harnessSlug: string }) => ctx.harnessSlug,
}));
vi.mock('./base-dir', () => ({ resolveCapabilityBaseDir: () => process.cwd() }));
vi.mock('./exec-sandbox', () => ({
  scrubExecEnv: () => ({ PATH: process.env.PATH, HOME: '/tmp' }),
}));

const ptyModule = process.env.P003_PTY_MODULE_PATH
  ? await import(/* @vite-ignore */ pathToFileURL(process.env.P003_PTY_MODULE_PATH).href)
  : await import('./pty');
const {
  ptyKillTool,
  ptyOpenTool,
  ptyReadScreenTool,
  ptyResizeTool,
  ptyWriteStdinTool,
} = ptyModule;

const ctx = () => ({
  uiClientId: 'su-resize',
  workspaceId: 'workspace-resize',
  harnessSlug: 'papercusp',
  projectDir: process.cwd(),
  isSuperuser: true,
  principal: { slug: 'system:superuser', workspaceId: 'workspace-resize' },
}) as never;

function textPayload(result: unknown): Record<string, any> {
  const item = (result as { content: Array<{ type: string; text?: string }> }).content.find((entry) => entry.type === 'text');
  return JSON.parse(item?.text ?? '{}');
}

async function waitForScreen(
  taskId: string,
  expected: string | RegExp,
  timeoutMs = 3_000,
): Promise<Record<string, any>> {
  const startedAt = Date.now();
  let last: Record<string, any> = {};
  while (Date.now() - startedAt < timeoutMs) {
    const result = await ptyReadScreenTool.handler({ task_id: taskId }, ctx()) as unknown as {
      content: Array<{ type: string; resource?: { uri?: string; mimeType?: string; text?: string } }>;
      _meta?: { pty?: Record<string, any> };
    };
    const item = result.content[0];
    last = {
      type: item?.type,
      resource: item?.resource,
      ...(result._meta?.pty ?? {}),
      data: item?.resource?.text ?? '',
    };
    const data = String(last.data);
    if (typeof expected === 'string' ? data.includes(expected) : expected.test(data)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return last;
}

afterEach(async () => {
  if (mocks.state.task?.taskId) {
    await ptyKillTool.handler({ task_id: mocks.state.task.taskId }, ctx()).catch(() => {});
  }
  mocks.state.task = null;
  mocks.state.enrolment = null;
  mocks.finishSyncEnrolment.mockClear();
});

describe('managed PTY resize', () => {
  it('changes stty dimensions in the same live child without replacing or ending the task', async () => {
    const opened = await ptyOpenTool.handler(
      {
        command: `printf 'READY\\n'; while IFS= read -r line; do eval "$line"; done`,
        cols: 80,
        rows: 24,
      },
      ctx(),
    );
    const taskId = String(textPayload(opened).task_id);
    const originalPid = mocks.state.task?.pid;
    expect(taskId).toBe('mptyresize0001');
    expect((await waitForScreen(taskId, 'READY')).data).toContain('READY');

    const resized = await ptyResizeTool.handler({ task_id: taskId, cols: 111, rows: 37 }, ctx());
    expect(textPayload(resized)).toEqual({ ok: true, task_id: taskId, cols: 111, rows: 37 });
    await ptyWriteStdinTool.handler(
      { task_id: taskId, data: `stty size; printf 'AFTER\\n'\n` },
      ctx(),
    );

    // The terminal echoes the command before executing it, so the literal
    // `AFTER` alone is not a completion signal. Wait for both the resized
    // kernel geometry and the marker emitted after `stty` has returned.
    const screen = await waitForScreen(taskId, /37 111[\s\S]*AFTER/);
    expect(String(screen.data)).toMatch(/37 111/);
    expect(screen).toMatchObject({
      type: 'resource',
      task_id: taskId,
      cols: 111,
      rows: 37,
      resource: {
        uri: `papercusp://pty/${taskId}/screen?cols=111&rows=37`,
        mimeType: 'application/x-papercusp-pty-screen+ansi',
      },
    });
    expect(mocks.state.task).toMatchObject({ taskId, pid: originalPid, state: 'running' });
    expect(mocks.finishSyncEnrolment).not.toHaveBeenCalled();
  });
});
