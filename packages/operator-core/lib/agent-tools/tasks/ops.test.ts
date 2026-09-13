import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../session-tasks', async () => {
  const actual = await vi.importActual<typeof import('../../session-tasks')>('../../session-tasks');
  return { ...actual, applySessionTaskOp: vi.fn() };
});

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({
    ownerId: 'su-session-1',
    workspaceId: 'ws-identity',
  })),
}));

vi.mock('./runtime', async () => {
  const actual = await vi.importActual<typeof import('./runtime')>('./runtime');
  return { ...actual, createSessionTaskLedgerBridge: vi.fn(async () => ({ seedWorkItem: null })) };
});

import { applySessionTaskOp, SessionTaskValidationError } from '../../session-tasks';
const applyM = vi.mocked(applySessionTaskOp);
const tool = (await import('./ops')).default;

type Out = { content: { text: string }[]; isError?: boolean };
const body = (out: Out) => JSON.parse(out.content[0]!.text);

function call(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  const emit = vi.fn();
  const tx = vi.fn();
  const promise = tool.handler(
    args as never,
    {
    workspaceId: 'ws-ctx',
    tx,
    emit,
    ...ctx,
    } as never,
  ) as Promise<Out>;
  return { emit, tx, promise };
}

beforeEach(() => vi.clearAllMocks());

describe('tasks:ops handler', () => {
  it('maps the public snake-case contract to the canonical store and emits a change event', async () => {
    applyM.mockResolvedValue({
      op: 'block',
      changedTaskId: 'task-a',
      tasks: [],
      links: [],
    });
    const { emit, tx, promise } = call({
      task_id: 'task-a',
      blocker_ref: 'wi:WI-9',
      explanation: 'Waiting on the ledger',
    });
    const out = body(await promise);

    expect(applyM).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
      workspaceId: 'ws-ctx',
      sessionId: 'su-session-1',
      taskId: 'task-a',
      blockerRef: 'wi:WI-9',
      explanation: 'Waiting on the ledger',
      }),
    );
    expect(out).toEqual({
      ok: true,
      sessionId: 'su-session-1',
      op: 'block',
      changedTaskId: 'task-a',
      tasks: [],
      links: [],
    });
    expect(emit).toHaveBeenCalledWith('tasks_changed', {
      sessionId: 'su-session-1',
      op: 'block',
      changedTaskId: 'task-a',
    });
  });

  it('maps typed link and promotion fields and returns the flattened edge set', async () => {
    applyM.mockResolvedValue({
      op: 'link',
      changedTaskId: 'task-a',
      tasks: [],
      links: [{ workItemId: 'WI-9', workItemHarness: 'papercusp', relation: 'for' }],
    });
    const out = body(
      await call({
      op: 'link',
      task_id: 'task-a',
      work_item_id: 'WI-9',
      work_item_harness: 'papercusp',
      relation: 'for',
      work_item_kind: 'change',
      work_item_title: 'Promoted title',
      work_item_summary: 'Promoted summary',
      }).promise,
    );

    expect(applyM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
      taskId: 'task-a',
      workItemId: 'WI-9',
      workItemHarness: 'papercusp',
      relation: 'for',
      workItemKind: 'change',
      workItemTitle: 'Promoted title',
      workItemSummary: 'Promoted summary',
      bridge: expect.any(Object),
      }),
    );
    expect(out.links).toEqual([{ workItemId: 'WI-9', workItemHarness: 'papercusp', relation: 'for' }]);
  });

  it('maps reorder and optimistic revision fields to the canonical store', async () => {
    applyM.mockResolvedValue({
      op: 'reorder',
      changedTaskId: 'task-a',
      tasks: [],
      links: [],
    });
    await call({
      op: 'reorder',
      task_id: 'task-a',
      position: 2,
      expected_updated_at: '2026-09-13T12:00:00.000Z',
    }).promise;
    expect(applyM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        op: 'reorder',
        taskId: 'task-a',
        position: 2,
        expectedUpdatedAt: '2026-09-13T12:00:00.000Z',
      }),
    );
  });

  it('uses the owned-loop chat run id, but not a generic per-call run id', async () => {
    applyM.mockResolvedValue({ op: 'view', changedTaskId: null, tasks: [], links: [] });

    await call({}, { runId: 'chat-77', spawnId: 'agent-loop-chat-77' }).promise;
    expect(applyM).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
      sessionId: 'chat-77',
      }),
    );

    await call({}, { runId: 'ephemeral-call-8', spawnId: 'ordinary-spawn' }).promise;
    expect(applyM).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
      sessionId: 'su-session-1',
      }),
    );
  });

  it('does not emit for view and returns precise validation failures', async () => {
    applyM.mockResolvedValueOnce({ op: 'view', changedTaskId: null, tasks: [], links: [] });
    const viewed = call({ op: 'view' });
    expect(body(await viewed.promise)).toMatchObject({ ok: true, op: 'view' });
    expect(viewed.emit).not.toHaveBeenCalled();

    applyM.mockRejectedValueOnce(new SessionTaskValidationError('task_not_found', 'missing'));
    const failed = await call({ op: 'done', task_id: 'missing' }).promise;
    expect(failed.isError).toBe(true);
    expect(body(failed)).toEqual({
      ok: false,
      error: { code: 'task_not_found', message: 'missing' },
    });
  });

  it('refuses an unscoped workspace instead of writing to a default partition', async () => {
    const failed = await call({}, { workspaceId: '*' }).promise;
    expect(failed.isError).toBe(true);
    expect(body(failed).error.code).toBe('workspace_required');
    expect(applyM).not.toHaveBeenCalled();
  });
});
