import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sensitiveText from '../sensitive-text';
import { emitTaskTerminalEvent, taskTerminalEventKey } from './task-terminal-events';

describe('task terminal awaited events', () => {
  const secret = 'p003-sample-result-secret-917a6e42';
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('redacts terminal payload and preserves the full original tuple at the producer boundary', async () => {
    vi.stubEnv('P003_RESULT_SECRET', secret);
    const exitReason = `runner ${secret} accessToken=sample-key-directed-value ${'x'.repeat(2001)}:decisive-tail`;
    const event = {
      taskId: 'tsk-redaction', workspaceId: 'workspace-a', harnessSlug: 'papercusp',
      taskClass: 'bash-job', launchedBy: 'su-a', state: 'exited' as const,
      exitCode: 7, exitReason, revision: 3,
    };
    const emit = vi.fn(async (_options: import('../events/await/engine').EmitAwaitedEventOpts) => ({ ok: true, latchRecorded: true }));
    const assertProtected = () => {
      const bytes = JSON.stringify(emit.mock.calls.map(([options]) => ({ payload: options.payload, summary: options.summary })));
      expect(bytes).not.toContain(secret);
      expect(bytes).not.toContain('sample-key-directed-value');
      expect(bytes).toContain('[redacted]');
      expect(bytes).toContain(`${'x'.repeat(2001)}:decisive-tail`);
    };
    expect(await emitTaskTerminalEvent(event, { emit })).toBe(true);
    assertProtected();
    expect(event.exitReason).toBe(exitReason);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      key: 'task:terminal:tsk-redaction', workspaceId: 'workspace-a',
      taskTerminal: { taskId: event.taskId, workspaceId: event.workspaceId, revision: 3, exitReason },
      payload: expect.objectContaining({ taskId: event.taskId, exitCode: 7, terminalEventRevision: 3 }),
    }));

    const bypass = vi.spyOn(sensitiveText, 'redactSensitiveText').mockImplementation(value => value);
    await emitTaskTerminalEvent(event, { emit });
    expect(bypass).toHaveBeenCalled();
    expect(JSON.stringify(emit.mock.calls.map(([options]) => options.payload))).toContain(secret);
    expect(() => assertProtected()).toThrow();
    bypass.mockRestore();
    emit.mockClear();
    expect(await emitTaskTerminalEvent(event, { emit })).toBe(true);
    assertProtected();
    expect(event.exitReason).toBe(exitReason);
  });

  it('redacts a failed-delivery diagnostic while retaining its original stack frame', async () => {
    vi.stubEnv('P003_RESULT_SECRET', secret);
    const cause = new Error(`backend rejected ${secret} accessToken=sample-key-directed-value`);
    cause.stack = `${cause.name}: ${cause.message}\n    at originalEmitter (/source/events/await/engine.ts:42:7)`;
    const originalStack = cause.stack;
    const warn = vi.fn();
    expect(await emitTaskTerminalEvent({
      taskId: 'tsk-redacted-error', workspaceId: 'workspace-a', harnessSlug: 'papercusp',
      taskClass: 'bash-job', launchedBy: 'su-a', state: 'killed', exitCode: 143, exitReason: null,
    }, { emit: async () => { throw cause; }, warn })).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    const bytes = JSON.stringify(warn.mock.calls);
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain('sample-key-directed-value');
    expect(bytes).toContain('[redacted]');
    expect(bytes).toContain('/source/events/await/engine.ts:42:7');
    expect(cause.stack).toBe(originalStack);
  });

  it('builds the task-scoped key and emits the complete observed terminal tuple', async () => {
    const emit = vi.fn(async () => ({ ok: true }));
    expect(taskTerminalEventKey('tsk-123')).toBe('task:terminal:tsk-123');

    const delivered = await emitTaskTerminalEvent(
      {
        taskId: 'tsk-123',
        workspaceId: 'workspace-a',
        harnessSlug: 'papercusp',
        taskClass: 'pty',
        launchedBy: 'su-a',
        state: 'exited',
        exitCode: 0,
        exitReason: null,
      },
      { emit },
    );
    expect(delivered).toBe(true);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith({
      key: 'task:terminal:tsk-123',
      summary: 'Managed pty task tsk-123 entered terminal state exited.',
      payload: {
        taskId: 'tsk-123',
        state: 'exited',
        exitCode: 0,
        exitReason: null,
        taskClass: 'pty',
        harness: 'papercusp',
        launchedBy: 'su-a',
      },
      source: 'task-manager',
      workspaceId: 'workspace-a',
    });
  });

  it('preserves the original error stack when terminal delivery fails during module initialization', async () => {
    const cause = new ReferenceError('Cannot access event module before initialization');
    cause.stack = `${cause.name}: ${cause.message}\n    at initializeEventModule (/source/events/await/engine.ts:42:7)`;
    const warn = vi.fn();

    await emitTaskTerminalEvent(
      {
        taskId: 'tsk-import-failed',
        workspaceId: 'workspace-a',
        harnessSlug: null,
        taskClass: 'bash-job',
        launchedBy: 'su-a',
        state: 'killed',
        exitCode: 137,
        exitReason: 'oom-kill',
      },
      { emit: async () => { throw cause; }, warn },
    );

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('terminal event failed for tsk-import-failed'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(cause.stack));
  });

  it('fails soft when wake delivery is unavailable', async () => {
    const warn = vi.fn();
    await emitTaskTerminalEvent(
      {
        taskId: 'tsk-failed',
        workspaceId: 'workspace-a',
        harnessSlug: null,
        taskClass: 'bash-job',
        launchedBy: 'su-a',
        state: 'killed',
        exitCode: 143,
        exitReason: 'signal',
      },
      { emit: async () => { throw new Error('wake backend down'); }, warn },
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wake backend down'));
  });

  it('retains pending intent when the engine succeeds without a durable latch', async () => {
    await expect(emitTaskTerminalEvent({
      taskId: 'tsk-latch-failed', workspaceId: 'workspace-a', harnessSlug: null,
      taskClass: 'bash-job', launchedBy: 'su-a', state: 'exited', exitCode: 0, exitReason: null,
    }, { emit: async () => ({ ok: true, latchRecorded: false }) })).resolves.toBe(false);
  });
});
