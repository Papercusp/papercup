import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../session-task-aliases', async () => {
  const actual = await vi.importActual<typeof import('../../session-task-aliases')>('../../session-task-aliases');
  return { ...actual, applySessionTaskSnapshot: vi.fn() };
});

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-session-1', workspaceId: 'ws-identity' })),
}));

vi.mock('./runtime', async () => {
  const actual = await vi.importActual<typeof import('./runtime')>('./runtime');
  return { ...actual, createSessionTaskLedgerBridge: vi.fn(async () => ({ seedWorkItem: null })) };
});

import { applySessionTaskSnapshot } from '../../session-task-aliases';
import { SessionTaskValidationError, type SessionTask } from '../../session-tasks';
const applyM = vi.mocked(applySessionTaskSnapshot);
const tool = (await import('./todo-write')).default;

type Out = { content: { text: string }[]; isError?: boolean };
const body = (out: Out) => JSON.parse(out.content[0]!.text);

function task(status: SessionTask['status'] = 'in_progress'): SessionTask {
  return {
    id: 'task-a',
    content: 'Ship facade',
    activeForm: 'Shipping facade',
    status,
    blockerRef: null,
    explanation: null,
    position: 0,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    links: [],
  };
}

function call(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  const emit = vi.fn();
  // No adv_sessions attachment: the SU owner keeps its own task list (D-019).
  const tx = vi.fn(async () => []);
  const promise = tool.handler(args as never, {
    workspaceId: 'ws-ctx',
    tx,
    emit,
    ...ctx,
  } as never) as Promise<Out>;
  return { emit, tx, promise };
}

beforeEach(() => vi.clearAllMocks());

describe('tasks:todo_write handler', () => {
  it('maps the native snapshot to the shared adapter and returns TodoWrite shape', async () => {
    applyM.mockResolvedValue({
      strategy: 'ops',
      mutations: [{ op: 'start', changedTaskId: 'task-a', tasks: [task()], links: [] }],
      tasks: [task()],
    });
    const native = [{ content: 'Ship facade', activeForm: 'Shipping facade', status: 'in_progress' }];
    const called = call({ todos: native });
    const out = body(await called.promise);

    expect(applyM).toHaveBeenCalledWith(called.tx, expect.objectContaining({
      workspaceId: 'ws-ctx',
      sessionId: 'su-session-1',
      tasks: native,
    }));
    expect(out).toEqual({ ok: true, sessionId: 'su-session-1', todos: native });
    expect(called.emit).toHaveBeenCalledWith('tasks_changed', {
      sessionId: 'su-session-1',
      op: 'start',
      changedTaskId: 'task-a',
    });
  });

  it('returns canonical validation failures and refuses unscoped writes', async () => {
    applyM.mockRejectedValueOnce(new SessionTaskValidationError('multiple_in_progress', 'too many'));
    const failed = await call({ todos: [] }).promise;
    expect(failed.isError).toBe(true);
    expect(body(failed).error).toEqual({ code: 'multiple_in_progress', message: 'too many' });

    const unscoped = await call({ todos: [] }, { workspaceId: '*' }).promise;
    expect(unscoped.isError).toBe(true);
    expect(body(unscoped).error.code).toBe('workspace_required');
  });
});
