import { describe, expect, it, vi } from 'vitest';
import { emitTaskTerminalEvent, taskTerminalEventKey } from './task-terminal-events';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('task terminal awaited events', () => {
  it('builds the task-scoped key and emits the complete observed terminal tuple', async () => {
    const emit = vi.fn(async () => ({ ok: true }));
    expect(taskTerminalEventKey('tsk-123')).toBe('task:terminal:tsk-123');

    emitTaskTerminalEvent(
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
    await flush();

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

  it('fails soft when wake delivery is unavailable', async () => {
    const warn = vi.fn();
    emitTaskTerminalEvent(
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
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wake backend down'));
  });
});
