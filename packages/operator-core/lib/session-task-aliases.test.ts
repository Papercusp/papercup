import { describe, expect, it, vi } from 'vitest';
import {
  applySessionTaskSnapshot,
  planSessionTaskSnapshot,
} from './session-task-aliases';
import type { SessionTask, SessionTaskResult } from './session-tasks';

function task(overrides: Partial<SessionTask> = {}): SessionTask {
  return {
    id: 'task-a',
    content: 'First task',
    activeForm: 'Doing first task',
    status: 'pending',
    blockerRef: null,
    explanation: null,
    position: 0,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    links: [],
    ...overrides,
  };
}

describe('planSessionTaskSnapshot', () => {
  it('turns a status-only replacement into canonical transitions', () => {
    const current = [
      task({ id: 'task-a', status: 'in_progress' }),
      task({
        id: 'task-b',
        content: 'Second task',
        activeForm: 'Doing second task',
        position: 1,
      }),
    ];

    const plan = planSessionTaskSnapshot(current, [
      { content: 'First task', activeForm: 'Doing first task', status: 'completed' },
      { content: 'Second task', activeForm: 'Doing second task', status: 'in_progress' },
    ], 'Moved to the second task');

    expect(plan.strategy).toBe('ops');
    expect(plan.ops).toEqual([
      { op: 'done', taskId: 'task-a', explanation: 'Moved to the second task' },
      { op: 'start', taskId: 'task-b', explanation: 'Moved to the second task' },
    ]);
    expect(plan.initTasks).toBeNull();
  });

  it('uses unblock for a native pending snapshot over a canonical blocker', () => {
    const current = [task({ status: 'blocked', blockerRef: 'event:ready' })];
    const plan = planSessionTaskSnapshot(current, [
      { content: 'First task', activeForm: 'Doing first task', status: 'pending' },
    ]);

    expect(plan.strategy).toBe('ops');
    expect(plan.ops).toEqual([{ op: 'unblock', taskId: 'task-a', explanation: undefined }]);
  });

  it('falls back to init for structural edits and preserves ids by exact entry identity', () => {
    const current = [
      task({ id: 'task-a' }),
      task({
        id: 'task-b',
        content: 'Second task',
        activeForm: 'Doing second task',
        position: 1,
      }),
    ];
    const plan = planSessionTaskSnapshot(current, [
      { content: 'Second task', activeForm: 'Doing second task', status: 'in_progress' },
      { content: 'New task', activeForm: 'Doing new task', status: 'pending' },
      { content: 'First task', activeForm: 'Doing first task', status: 'completed' },
    ]);

    expect(plan.strategy).toBe('init');
    expect(plan.initTasks).toEqual([
      { id: 'task-b', content: 'Second task', activeForm: 'Doing second task', status: 'in_progress' },
      { content: 'New task', activeForm: 'Doing new task', status: 'pending' },
      { id: 'task-a', content: 'First task', activeForm: 'Doing first task', status: 'completed' },
    ]);
  });

  it('falls back to init for a completed-to-pending reopen', () => {
    const current = [task({ status: 'completed' })];
    const plan = planSessionTaskSnapshot(current, [
      { content: 'First task', activeForm: 'Doing first task', status: 'pending' },
    ]);

    expect(plan.strategy).toBe('init');
    expect(plan.initTasks?.[0]).toMatchObject({ id: 'task-a', status: 'pending' });
  });

  it('is a true no-op only when neither state nor explanation changed', () => {
    const current = [task()];
    expect(planSessionTaskSnapshot(current, [
      { content: 'First task', activeForm: 'Doing first task', status: 'pending' },
    ]).strategy).toBe('noop');
    expect(planSessionTaskSnapshot(current, [
      { content: 'First task', activeForm: 'Doing first task', status: 'pending' },
    ], 'Why the plan stayed put').strategy).toBe('init');
  });
});

describe('applySessionTaskSnapshot', () => {
  it('reads once, then applies each planned canonical mutation in order', async () => {
    const current = [
      task({ id: 'task-a', status: 'in_progress' }),
      task({ id: 'task-b', content: 'Second', activeForm: 'Doing second', position: 1 }),
    ];
    const afterDone = [
      { ...current[0]!, status: 'completed' as const },
      current[1]!,
    ];
    const final = [
      afterDone[0]!,
      { ...current[1]!, status: 'in_progress' as const },
    ];
    const results: SessionTaskResult[] = [
      { op: 'view', changedTaskId: null, tasks: current, links: [] },
      { op: 'done', changedTaskId: 'task-a', tasks: afterDone, links: [] },
      { op: 'start', changedTaskId: 'task-b', tasks: final, links: [] },
    ];
    const apply = vi.fn()
      .mockResolvedValueOnce(results[0])
      .mockResolvedValueOnce(results[1])
      .mockResolvedValueOnce(results[2]);

    const out = await applySessionTaskSnapshot(vi.fn() as never, {
      workspaceId: 'ws-1',
      sessionId: 'session-1',
      explanation: 'Advance',
      tasks: [
        { content: 'First task', activeForm: 'Doing first task', status: 'completed' },
        { content: 'Second', activeForm: 'Doing second', status: 'in_progress' },
      ],
      idFactory: () => 'unused',
    }, apply as never);

    expect(apply).toHaveBeenCalledTimes(3);
    expect(apply.mock.calls[1]?.[1]).toMatchObject({ op: 'done', taskId: 'task-a' });
    expect(apply.mock.calls[2]?.[1]).toMatchObject({ op: 'start', taskId: 'task-b' });
    expect(out).toEqual({ strategy: 'ops', mutations: [results[1], results[2]], tasks: final });
  });
});
