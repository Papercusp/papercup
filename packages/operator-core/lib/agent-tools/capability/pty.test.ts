import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state: {
    task: Record<string, unknown> | null;
    handle: Record<string, any> | null;
    writes: string[];
    resizes: Array<{ cols: number; rows: number }>;
  } = { task: null, handle: null, writes: [], resizes: [] };

  const beginSyncEnrolment = vi.fn(() => ({
    taskId: 'mptysession001',
    confined: true,
    unconfinedReason: null as string | null,
    unitKind: 'scope',
    scopeUnit: 'pc-mptysession001.scope' as string | null,
    enrolled: true,
    registrationReady: null as Promise<void> | null,
    wrap: vi.fn((binary: string, argv: string[]) => ({ binary: 'systemd-run', argv: ['--scope', binary, ...argv] })),
  }));
  const completeSyncEnrolment = vi.fn((enrolment: any, spec: any, pid: number, opts: any) => {
    state.task = {
      taskId: enrolment.taskId,
      class: spec.class,
      workspaceId: opts.workspaceId,
      harnessSlug: spec.harnessSlug,
      launchedBy: spec.launchedBy,
      detail: spec.detail,
      state: 'running',
    };
    enrolment.registrationReady = Promise.resolve();
  });
  const finishSyncEnrolment = vi.fn();
  const syncEnrolmentScopePath = vi.fn(() => '/user.slice/papercusp-pty.slice/pc-mptysession001.scope');
  const spawnPty = vi.fn((opts: any) => {
    const handle = {
      id: 'pty-local-1',
      taskId: opts.taskId,
      accessScope: opts.accessScope,
      pty: { pid: 4242 },
      headless: { cols: opts.cols, rows: opts.rows },
      onExit: new Set<(code: number, signal: number) => void>(),
      killed: false,
      exitCode: null,
    };
    state.handle = handle;
    return handle;
  });
  const getPtyByTaskId = vi.fn((taskId: string, scope: any) => {
    const handle = state.handle;
    if (!handle || handle.taskId !== taskId) return undefined;
    return JSON.stringify(handle.accessScope) === JSON.stringify(scope) ? handle : undefined;
  });
  const writePty = vi.fn((_id: string, data: Buffer) => {
    state.writes.push(data.toString('utf8'));
    return true;
  });
  const getScreenSerialization = vi.fn(async () => '\u001b[2JREADY>');
  const resizePty = vi.fn((_id: string, cols: number, rows: number) => {
    if (!state.handle) return false;
    state.handle.headless.cols = cols;
    state.handle.headless.rows = rows;
    state.resizes.push({ cols, rows });
    return true;
  });
  const killPty = vi.fn(() => true);

  return {
    state,
    beginSyncEnrolment,
    completeSyncEnrolment,
    finishSyncEnrolment,
    syncEnrolmentScopePath,
    spawnPty,
    getPtyByTaskId,
    writePty,
    resizePty,
    getScreenSerialization,
    killPty,
    getTask: vi.fn(async () => state.task),
    scrubExecEnv: vi.fn(() => ({ PATH: '/usr/bin', HOME: '/home/test' })),
  };
});

vi.mock('../../task-manager/enroll-sync', () => ({
  beginSyncEnrolment: mocks.beginSyncEnrolment,
  completeSyncEnrolment: mocks.completeSyncEnrolment,
  finishSyncEnrolment: mocks.finishSyncEnrolment,
  syncEnrolmentScopePath: mocks.syncEnrolmentScopePath,
}));
vi.mock('../../task-manager/store', () => ({ getTask: mocks.getTask }));
vi.mock('../../pty-bridge', () => ({
  spawnPty: mocks.spawnPty,
  spawnGovernedPty: (opts: unknown) => mocks.spawnPty(opts),
  getPtyByTaskId: mocks.getPtyByTaskId,
  writePty: mocks.writePty,
  resizePty: mocks.resizePty,
  getScreenSerialization: mocks.getScreenSerialization,
  killPty: mocks.killPty,
}));
vi.mock('../../pty-ticket', () => ({ localPtyHostId: () => 'host-test' }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: (ctx: { uiClientId?: string; workspaceId?: string }) => ({
    ownerId: ctx.uiClientId ?? 'su-test',
    ownerLabel: 'su test',
    source: 'omp-hook-session',
    workspaceId: ctx.workspaceId ?? null,
    userId: null,
  }),
}));
vi.mock('../_harness-scope', () => ({
  resolveConcreteHarnessSlug: (_arg: unknown, ctx: { harnessSlug?: string }) =>
    ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : null,
}));
vi.mock('./base-dir', () => ({ resolveCapabilityBaseDir: () => '/repo' }));
vi.mock('./exec-sandbox', () => ({ scrubExecEnv: mocks.scrubExecEnv }));

import {
  ptyKillTool,
  ptyOpenTool,
  ptyReadScreenTool,
  ptyResizeTool,
  ptyWriteStdinTool,
} from './pty';

function ctx(ownerId = 'su-a', workspaceId = 'ws-a', harnessSlug = 'papercusp') {
  return {
    uiClientId: ownerId,
    isSuperuser: true,
    workspaceId,
    harnessSlug,
    projectDir: '/repo',
    principal: { slug: 'system:superuser', workspaceId },
  } as never;
}

function parseText(result: unknown): Record<string, any> {
  const typed = result as { content: Array<{ type: string; text?: string }> };
  return JSON.parse(typed.content[0]!.text!);
}

beforeEach(() => {
  mocks.state.task = null;
  mocks.state.handle = null;
  mocks.state.writes = [];
  mocks.state.resizes = [];
  vi.clearAllMocks();
  mocks.beginSyncEnrolment.mockImplementation(() => ({
    taskId: 'mptysession001',
    confined: true,
    unconfinedReason: null,
    unitKind: 'scope',
    scopeUnit: 'pc-mptysession001.scope',
    enrolled: true,
    registrationReady: null,
    wrap: vi.fn((binary: string, argv: string[]) => ({ binary: 'systemd-run', argv: ['--scope', binary, ...argv] })),
  }));
});

describe('interactive PTY capability family', () => {
  it('opens a confined task-ledger session and exposes only its durable task id', async () => {
    const result = await ptyOpenTool.handler(
      { command: 'node', cwd: 'packages/operator-core', cols: 100, rows: 30 },
      ctx(),
    );
    const payload = parseText(result);

    expect(payload).toEqual({ ok: true, task_id: 'mptysession001', confined: true, cols: 100, rows: 30 });
    expect(JSON.stringify(result)).not.toContain('pty-local-1');
    expect(mocks.beginSyncEnrolment).toHaveBeenCalledWith({ class: 'pty' });
    expect(mocks.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'systemd-run',
        args: ['--scope', 'bash', '-lc', 'node'],
        cwd: '/repo/packages/operator-core',
        inheritEnv: false,
        taskId: 'mptysession001',
        accessScope: {
          tenantId: 'ws-a',
          workspaceId: 'ws-a',
          harnessSlug: 'papercusp',
          hostId: 'host-test',
          principalId: 'su-a',
        },
      }),
    );
    expect(mocks.completeSyncEnrolment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        class: 'pty',
        launchedBy: 'su-a',
        harnessSlug: 'papercusp',
        detail: expect.objectContaining({
          capabilityPty: true,
          ptyHandleId: 'pty-local-1',
          principalId: 'su-a',
        }),
      }),
      4242,
      { workspaceId: 'ws-a' },
    );
  });

  it('re-authorizes write, resize, screen-read, and kill by task id under the current caller', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx());

    const write = await ptyWriteStdinTool.handler(
      { task_id: 'mptysession001', data: 'echo ok\n' },
      ctx(),
    );
    expect(parseText(write)).toMatchObject({ ok: true, task_id: 'mptysession001', bytes_written: 8 });
    expect(mocks.state.writes).toEqual(['echo ok\n']);

    const resized = await ptyResizeTool.handler(
      { task_id: 'mptysession001', cols: 111, rows: 37 },
      ctx(),
    );
    expect(parseText(resized)).toEqual({
      ok: true,
      task_id: 'mptysession001',
      cols: 111,
      rows: 37,
    });
    expect(mocks.state.resizes).toEqual([{ cols: 111, rows: 37 }]);
    expect(mocks.resizePty).toHaveBeenCalledWith(
      'pty-local-1',
      111,
      37,
      expect.objectContaining({ principalId: 'su-a' }),
    );

    const read = (await ptyReadScreenTool.handler(
      { task_id: 'mptysession001' },
      ctx(),
    )) as unknown as { content: Array<Record<string, unknown>> };
    expect(read.content).toEqual([
      {
        type: 'pty',
        task_id: 'mptysession001',
        mimeType: 'application/x-papercusp-pty-screen+ansi',
        encoding: 'utf-8',
        cols: 111,
        rows: 37,
        data: '\u001b[2JREADY>',
      },
    ]);

    const killed = await ptyKillTool.handler({ task_id: 'mptysession001' }, ctx());
    expect(parseText(killed)).toEqual({ ok: true, task_id: 'mptysession001', killed: true });
    expect(mocks.killPty).toHaveBeenLastCalledWith(
      'pty-local-1',
      expect.objectContaining({ principalId: 'su-a' }),
    );
    expect(mocks.getTask).toHaveBeenCalledTimes(4);
  });

  it('reattaches after a client carry-respawn and makes screen-read retries idempotent', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx('su-a'));
    const durableTask = { ...mocks.state.task };
    const durableHandle = mocks.state.handle;

    // A carry-respawn creates a fresh client context but leaves the server-side
    // ledger row and PTY bridge alive. The durable task id is the only state the
    // successor needs; no process-local PTY id crosses the model-facing seam.
    const resumedCtx = ctx('su-a');
    mocks.state.task = durableTask;
    mocks.state.handle = durableHandle;
    const first = await ptyReadScreenTool.handler({ task_id: 'mptysession001' }, resumedCtx);
    const retry = await ptyReadScreenTool.handler({ task_id: 'mptysession001' }, resumedCtx);

    expect(first).toEqual(retry);
    expect(mocks.spawnPty).toHaveBeenCalledTimes(1);
    expect(mocks.getTask).toHaveBeenCalledTimes(2);
    expect(mocks.getScreenSerialization).toHaveBeenCalledTimes(2);
    expect(mocks.getScreenSerialization).toHaveBeenNthCalledWith(
      1,
      'pty-local-1',
      expect.objectContaining({ principalId: 'su-a' }),
    );
    expect(JSON.stringify(first)).not.toContain('pty-local-1');
  });

  it('collapses cross-owner and malformed task rows to the same unknown_task_id result', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx('su-a'));

    const foreign = await ptyWriteStdinTool.handler(
      { task_id: 'mptysession001', data: 'stolen\n' },
      ctx('su-b'),
    );
    expect(parseText(foreign)).toEqual({ ok: false, reason: 'unknown_task_id', task_id: 'mptysession001' });
    expect((foreign as { isError?: boolean }).isError).toBe(true);

    mocks.state.task = { ...mocks.state.task, class: 'bash-job' };
    const malformed = await ptyKillTool.handler({ task_id: 'mptysession001' }, ctx('su-a'));
    expect(parseText(malformed)).toEqual({ ok: false, reason: 'unknown_task_id', task_id: 'mptysession001' });
    expect(mocks.writePty).not.toHaveBeenCalled();
    expect(mocks.killPty).not.toHaveBeenCalled();
  });

  it('distinguishes an ended PTY from an unrecoverable lost live handle without starting a replacement', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx('su-a'));
    mocks.state.handle = null;

    const lost = await ptyReadScreenTool.handler({ task_id: 'mptysession001' }, ctx('su-a'));
    expect(parseText(lost)).toMatchObject({
      ok: false,
      reason: 'pty_session_unavailable',
      state: 'running',
      reattachment: 'unrecoverable',
      restart_required: true,
      replacement_started: false,
    });
    expect(mocks.spawnPty).toHaveBeenCalledTimes(1);

    mocks.state.task = {
      ...mocks.state.task,
      state: 'exited',
      exitCode: 0,
      exitReason: null,
    };
    const ended = await ptyReadScreenTool.handler({ task_id: 'mptysession001' }, ctx('su-a'));
    expect(parseText(ended)).toMatchObject({
      ok: false,
      reason: 'pty_session_ended',
      state: 'exited',
      exit_code: 0,
      reattachment: 'not_applicable',
      replacement_started: false,
    });
    expect(mocks.spawnPty).toHaveBeenCalledTimes(1);
  });

  it('fails closed before spawn when cgroup confinement is unavailable', async () => {
    mocks.beginSyncEnrolment.mockImplementationOnce(() => ({
      taskId: 'mptysession001',
      confined: false,
      unconfinedReason: 'probe-pending',
      unitKind: 'scope',
      scopeUnit: null,
      enrolled: true,
      registrationReady: null,
      wrap: vi.fn(),
    }));

    const result = await ptyOpenTool.handler({ command: 'bash' }, ctx());
    expect(parseText(result)).toMatchObject({
      ok: false,
      reason: 'pty_confinement_unavailable',
      unconfined_reason: 'probe-pending',
    });
    expect(mocks.spawnPty).not.toHaveBeenCalled();
  });
});
