import { describe, expect, it, vi } from 'vitest';
import type { ConversationContextProjection } from '../../../conversation-context-projection';
import type { SessionTask, SessionTaskResult } from '../../../session-tasks';
import { AgentChatTaskMutationError, mutateAgentChatTask, taskOpsRoute } from './task-ops';

const BASE_TASK: SessionTask = {
  id: 'task-1',
  content: 'Original task',
  activeForm: 'Doing original task',
  status: 'blocked',
  blockerRef: 'waiting for a person',
  explanation: 'Paused',
  position: 0,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
  links: [],
};

function projection(taskWrite = true): ConversationContextProjection {
  return {
    schemaVersion: 'conversation-context-v1',
    session: {
      sourceKind: 'agent_chat',
      sessionId: 'chat-1',
      harness: 'papercusp',
      role: 'worker',
      linkedWorkItemId: null,
      capabilityTier: taskWrite ? 'owned-loop' : 'transcript-only',
    },
    capabilities: { liveFrames: taskWrite, taskWrite, approvalWrite: taskWrite },
    frames: [],
  };
}

function result(op: SessionTaskResult['op'], tasks = [BASE_TASK]): SessionTaskResult {
  return {
    op,
    changedTaskId: tasks[0]?.id ?? null,
    tasks,
    links: tasks.flatMap((task) => task.links),
  };
}

function deps(taskWrite = true) {
  const readProjection = vi.fn(async () => projection(taskWrite));
  const applyOp = vi.fn(async (_sql, input) => result(input.op ?? 'view'));
  const acquireLock = vi.fn(async () => undefined);
  const ledgerBridge = {};
  const createLedgerBridge = vi.fn(async () => ledgerBridge);
  return {
    readProjection,
    applyOp,
    acquireLock,
    createLedgerBridge,
    ledgerBridge,
    withWorkspace: async <T>(_workspaceId: string, run: (sql: any) => Promise<T>) => run({}),
    idFactory: () => 'task-new',
  };
}

const scope = {
  workspaceId: 'workspace-1',
  harness: 'papercusp',
  sessionId: 'chat-1',
  actorId: 'pui:avi',
};

describe('agent-chat user task operations', () => {
  it('registers one loopback route on the existing agent-chat surface', () => {
    expect(taskOpsRoute).toMatchObject({
      method: 'POST',
      path: '/harness/:slug/agent-chats/:chatId/tasks',
      auth: 'loopback',
    });
  });

  it.each([
    ['add', 'append'],
    ['edit', 'edit'],
    ['start', 'start'],
    ['check', 'done'],
    ['drop', 'drop'],
    ['clear_blocker', 'unblock'],
    ['reopen', 'reopen'],
    ['promote', 'promote'],
  ] as const)('maps user action %s to canonical op %s', async (action, canonicalOp) => {
    const d = deps();
    await mutateAgentChatTask(
      {
      ...scope,
      action,
      ...(action === 'add'
        ? { content: 'Added task' }
        : action === 'edit'
          ? { taskId: 'task-1', content: 'Edited task' }
          : { taskId: 'task-1' }),
      },
      d,
    );
    expect(d.applyOp).toHaveBeenLastCalledWith({}, expect.objectContaining({ op: canonicalOp }));
    expect(d.readProjection).toHaveBeenCalledTimes(2);
  });

  it('maps owner block input and optimistic revision to one canonical mutation', async () => {
    const d = deps();
    await mutateAgentChatTask(
      {
        ...scope,
        action: 'block',
        taskId: 'task-1',
        blockerRef: 'waiting for owner review',
        expectedUpdatedAt: BASE_TASK.updatedAt,
      },
      d,
    );
    expect(d.applyOp).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        op: 'block',
        taskId: 'task-1',
        blockerRef: 'waiting for owner review',
        expectedUpdatedAt: BASE_TASK.updatedAt,
      }),
    );
  });

  it('derives move-down from the current canonical position before reordering', async () => {
    const d = deps();
    const second = { ...BASE_TASK, id: 'task-2', position: 1 };
    d.applyOp.mockResolvedValueOnce(result('view', [BASE_TASK, second]));
    d.applyOp.mockResolvedValueOnce(result('reorder', [second, BASE_TASK]));
    await mutateAgentChatTask(
      {
        ...scope,
        action: 'move_down',
        taskId: 'task-1',
        expectedUpdatedAt: BASE_TASK.updatedAt,
      },
      d,
    );
    expect(d.applyOp).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({
        op: 'reorder',
        taskId: 'task-1',
        position: 1,
        expectedUpdatedAt: BASE_TASK.updatedAt,
      }),
    );
    expect(d.acquireLock).toHaveBeenCalledWith({}, 'workspace-1', 'chat-1');
  });

  it('routes edit through one atomic canonical op and returns the edited id', async () => {
    const d = deps();
    d.applyOp.mockResolvedValueOnce(result('edit', [{ ...BASE_TASK, content: 'Edited task' }]));
    const output = await mutateAgentChatTask(
      {
      ...scope,
      action: 'edit',
      taskId: 'task-1',
      content: 'Edited task',
      activeForm: 'Editing task',
      },
      d,
    );
    expect(d.applyOp).toHaveBeenCalledOnce();
    expect(d.applyOp).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
      op: 'edit',
      taskId: 'task-1',
      content: 'Edited task',
      activeForm: 'Editing task',
      }),
    );
    expect(output.changedTaskId).toBe('task-1');
  });

  it('builds the ledger bridge with the authenticated actor and route scope', async () => {
    const d = deps();
    await mutateAgentChatTask(
      {
      ...scope,
      action: 'promote',
      taskId: 'task-1',
      },
      d,
    );
    expect(d.createLedgerBridge).toHaveBeenCalledOnce();
    expect(d.createLedgerBridge).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sessionId: 'chat-1',
      actorId: 'pui:avi',
      defaultHarness: 'papercusp',
      sql: {},
    });
    expect(d.applyOp).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({
      op: 'promote',
      bridge: d.ledgerBridge,
      }),
    );
  });

  it('refuses manual clearing of a typed blocker', async () => {
    const d = deps();
    d.applyOp.mockResolvedValueOnce(result('view', [{ ...BASE_TASK, blockerRef: 'wi:WI-9' }]));
    await expect(
      mutateAgentChatTask(
        {
      ...scope,
      action: 'clear_blocker',
      taskId: 'task-1',
        },
        d,
      ),
    ).rejects.toMatchObject({ code: 'typed_blocker_live' });
    expect(d.applyOp).toHaveBeenCalledTimes(1);
  });

  it('refuses writes when the shared projection exposes a read-only capability tier', async () => {
    const d = deps(false);
    await expect(
      mutateAgentChatTask(
        {
      ...scope,
      action: 'check',
      taskId: 'task-1',
        },
        d,
      ),
    ).rejects.toMatchObject({ code: 'task_write_unavailable' });
    expect(d.applyOp).not.toHaveBeenCalled();
  });
});
