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
import type { SessionTask } from '../../session-tasks';
const applyM = vi.mocked(applySessionTaskSnapshot);
const tool = (await import('./update-plan')).default;

type Out = { content: { text: string }[]; isError?: boolean };
const body = (out: Out) => JSON.parse(out.content[0]!.text);

function task(): SessionTask {
  return {
    id: 'task-a',
    content: 'Ship facade',
    activeForm: 'Ship facade',
    status: 'completed',
    blockerRef: null,
    explanation: 'All done',
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

describe('tasks:update_plan handler', () => {
  it('maps Codex step/explanation fields and returns update_plan shape', async () => {
    applyM.mockResolvedValue({
      strategy: 'ops',
      mutations: [{ op: 'done', changedTaskId: 'task-a', tasks: [task()], links: [] }],
      tasks: [task()],
    });
    const called = call({
      explanation: 'All done',
      plan: [{ step: 'Ship facade', status: 'completed' }],
    });
    const out = body(await called.promise);

    expect(applyM).toHaveBeenCalledWith(called.tx, expect.objectContaining({
      workspaceId: 'ws-ctx',
      sessionId: 'su-session-1',
      explanation: 'All done',
      tasks: [{ content: 'Ship facade', activeForm: 'Ship facade', status: 'completed' }],
    }));
    expect(out).toEqual({
      ok: true,
      sessionId: 'su-session-1',
      explanation: 'All done',
      plan: [{ step: 'Ship facade', status: 'completed' }],
    });
    expect(called.emit).toHaveBeenCalledWith('tasks_changed', {
      sessionId: 'su-session-1',
      op: 'done',
      changedTaskId: 'task-a',
    });
  });

  it('uses the owned-loop run id for the same canonical session as tasks:ops', async () => {
    applyM.mockResolvedValue({ strategy: 'noop', mutations: [], tasks: [] });
    await call({ plan: [] }, { runId: 'chat-77', spawnId: 'agent-loop-chat-77' }).promise;
    expect(applyM).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sessionId: 'chat-77',
    }));
  });
});
