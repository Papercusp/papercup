import { describe, expect, it, vi } from 'vitest';
import {
  acquireSessionTaskLock,
  inferSessionTaskOp,
  reduceSessionTasks,
  SessionTaskValidationError,
  type SessionTask,
} from './session-tasks';

const NOW = '2026-08-26T12:00:00.000Z';
const NEXT = '2026-08-26T12:01:00.000Z';

function task(overrides: Partial<SessionTask> = {}): SessionTask {
  return {
    id: 'task-a',
    content: 'Inspect the engine',
    activeForm: 'Inspecting the engine',
    status: 'pending',
    blockerRef: null,
    explanation: null,
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
    links: [],
    ...overrides,
  };
}

function reduce(current: readonly SessionTask[], args: Parameters<typeof reduceSessionTasks>[1]) {
  let serial = 0;
  return reduceSessionTasks(current, args, {
    now: NEXT,
    idFactory: () => `task-new-${++serial}`,
  });
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error('expected validation failure');
  } catch (error) {
    expect(error).toBeInstanceOf(SessionTaskValidationError);
    expect((error as SessionTaskValidationError).code).toBe(code);
  }
}

describe('inferSessionTaskOp', () => {
  it('infers only unambiguous shapes', () => {
    expect(inferSessionTaskOp({ tasks: [] })).toBe('init');
    expect(inferSessionTaskOp({ content: 'New task' })).toBe('append');
    expect(inferSessionTaskOp({ taskId: 'task-a', blockerRef: 'wi:WI-1' })).toBe('block');
    expect(inferSessionTaskOp({})).toBe('view');
    expectCode(() => inferSessionTaskOp({ taskId: 'task-a' }), 'op_ambiguous');
  });
});

describe('acquireSessionTaskLock', () => {
  it('uses the canonical transaction advisory-lock namespace and validates scope', async () => {
    const sql = vi.fn();
    await acquireSessionTaskLock(sql as never, 'ws-1', 'session-1');
    expect(sql).toHaveBeenCalledTimes(1);
    expect(sql.mock.calls[0]?.[1]).toBe(JSON.stringify(['ws-1', 'session-1']));
    expect(sql.mock.calls[0]?.[1]).not.toContain('\u0000');
    expect((sql.mock.calls[0]?.[0] as unknown as string[]).join('')).toContain('981');

    await expect(acquireSessionTaskLock(sql as never, ' ', 'session-1')).rejects.toMatchObject({
      code: 'workspace_id_required',
    });
  });

  it('escapes control characters in the composite lock key instead of sending NUL to PostgreSQL', async () => {
    const sql = vi.fn();
    await acquireSessionTaskLock(sql as never, 'ws-\u0000-1', 'session-1');

    expect(sql.mock.calls[0]?.[1]).toBe(JSON.stringify(['ws-\u0000-1', 'session-1']));
    expect(sql.mock.calls[0]?.[1]).not.toContain('\u0000');
  });
});

describe('reduceSessionTasks', () => {
  it('initializes normalized tasks and enforces one active task', () => {
    const out = reduce([], {
      op: 'init',
      explanation: 'Initial execution plan',
      tasks: [
        { id: 'task-a', content: ' First ', activeForm: ' Doing first ', status: 'in_progress' },
        { content: 'Second' },
      ],
    });

    expect(out.tasks).toEqual([
      expect.objectContaining({
        id: 'task-a',
        content: 'First',
        activeForm: 'Doing first',
        status: 'in_progress',
        explanation: 'Initial execution plan',
        position: 0,
      }),
      expect.objectContaining({
        id: 'task-new-1',
        content: 'Second',
        activeForm: 'Second',
        status: 'pending',
        explanation: 'Initial execution plan',
        position: 1,
      }),
    ]);

    expectCode(
      () =>
        reduce([], {
        op: 'init',
        tasks: [
          { content: 'One', status: 'in_progress' },
          { content: 'Two', status: 'in_progress' },
        ],
      }),
      'multiple_in_progress',
    );
  });

  it('start demotes the prior active task without mutating the input', () => {
    const current = [
      task({ id: 'task-a', status: 'in_progress' }),
      task({ id: 'task-b', content: 'Build it', position: 1 }),
    ];
    const snapshot = structuredClone(current);

    const out = reduce(current, {
      op: 'start',
      taskId: 'task-b',
      activeForm: 'Building the keystone',
      explanation: 'Keystone ready',
    });

    expect(current).toEqual(snapshot);
    expect(out.changedTaskId).toBe('task-b');
    expect(out.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'task-a', status: 'pending' },
      { id: 'task-b', status: 'in_progress' },
    ]);
    expect(out.tasks[0]).toMatchObject({ explanation: 'Keystone ready', updatedAt: NEXT });
    expect(out.tasks[1]).toMatchObject({
      activeForm: 'Building the keystone',
      explanation: 'Keystone ready',
      updatedAt: NEXT,
    });
  });

  it('supports append, block, unblock, done, and drop transitions', () => {
    const appended = reduce([], {
      content: ' Write tests ',
      activeForm: ' Writing tests ',
      explanation: 'Acceptance guard',
    });
    expect(appended).toMatchObject({ op: 'append', changedTaskId: 'task-new-1' });
    expect(appended.tasks[0]).toMatchObject({
      content: 'Write tests',
      activeForm: 'Writing tests',
      status: 'pending',
      explanation: 'Acceptance guard',
    });

    const blocked = reduce(appended.tasks, {
      op: 'block',
      taskId: 'task-new-1',
      blockerRef: 'event:fleet:contract-ready',
    });
    expect(blocked.tasks[0]).toMatchObject({
      status: 'blocked',
      blockerRef: 'event:fleet:contract-ready',
    });

    const unblocked = reduce(blocked.tasks, { op: 'unblock', taskId: 'task-new-1' });
    expect(unblocked.tasks[0]).toMatchObject({ status: 'pending', blockerRef: null });

    const done = reduce(unblocked.tasks, { op: 'done', taskId: 'task-new-1' });
    expect(done.tasks[0]).toMatchObject({ status: 'completed' });

    const dropped = reduce([task()], { op: 'drop', taskId: 'task-a' });
    expect(dropped.tasks[0]).toMatchObject({ status: 'dropped' });
  });

  it('edits one task atomically without replacing unrelated task metadata', () => {
    const current = [
      task({
        id: 'task-a',
        status: 'blocked',
        blockerRef: 'wi:WI-9',
        explanation: 'Waiting on the ledger',
      }),
      task({
        id: 'task-b',
        content: 'Unrelated task',
        activeForm: 'Doing unrelated task',
        position: 1,
      }),
    ];

    const out = reduce(current, {
      op: 'edit',
      taskId: 'task-a',
      content: 'Edited task',
      explanation: 'Clarified by the user',
    });

    expect(out).toMatchObject({ op: 'edit', changedTaskId: 'task-a' });
    expect(out.tasks[0]).toEqual({
      ...current[0],
      content: 'Edited task',
      activeForm: 'Edited task',
      explanation: 'Clarified by the user',
      updatedAt: NEXT,
    });
    expect(out.tasks[1]).toEqual(current[1]);
  });

  it('rejects a stale owner revision without changing any task bytes', () => {
    const current = [task({ updatedAt: NEXT })];
    const snapshot = structuredClone(current);

    expectCode(
      () =>
        reduce(current, {
          op: 'edit',
          taskId: 'task-a',
          content: 'Stale overwrite',
          expectedUpdatedAt: NOW,
        }),
      'task_revision_conflict',
    );
    expect(current).toEqual(snapshot);
  });

  it('reopens terminal tasks and reorders the canonical list with contiguous positions', () => {
    const reopened = reduce(
      [
        task({ id: 'task-a', status: 'completed' }),
        task({ id: 'task-b', position: 1 }),
        task({ id: 'task-c', position: 2 }),
      ],
      {
        op: 'reopen',
        taskId: 'task-a',
        expectedUpdatedAt: NOW,
      },
    );
    expect(reopened.tasks[0]).toMatchObject({
      id: 'task-a',
      status: 'pending',
      updatedAt: NEXT,
    });

    const reordered = reduce(reopened.tasks, {
      op: 'reorder',
      taskId: 'task-c',
      position: 0,
      expectedUpdatedAt: NOW,
    });
    expect(reordered.tasks.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: 'task-c', position: 0 },
      { id: 'task-a', position: 1 },
      { id: 'task-b', position: 2 },
    ]);
    expect(reordered.tasks.every((row) => row.updatedAt === NEXT)).toBe(true);
  });

  it('supports one checkpoint-sync for edge plus unbounded informational edges', () => {
    const first = reduce([task()], {
      op: 'link',
      taskId: 'task-a',
      workItemId: 'WI-1',
      workItemHarness: 'papercusp',
      relation: 'for',
    });
    const related = reduce(first.tasks, {
      op: 'link',
      taskId: 'task-a',
      workItemId: 'WI-2',
      workItemHarness: 'papercusp',
      relation: 'relates',
    });
    expect(related.tasks[0]!.links).toEqual([
      { workItemId: 'WI-1', workItemHarness: 'papercusp', relation: 'for' },
      { workItemId: 'WI-2', workItemHarness: 'papercusp', relation: 'relates' },
    ]);
    expect(related.links).toEqual(related.tasks[0]!.links);

    expectCode(
      () =>
        reduce(related.tasks, {
      op: 'link',
      taskId: 'task-a',
      workItemId: 'WI-3',
      relation: 'for',
        }),
      'for_link_exists',
    );

    const unlinked = reduce(related.tasks, {
      op: 'unlink',
      taskId: 'task-a',
      workItemId: 'WI-2',
      workItemHarness: 'papercusp',
    });
    expect(unlinked.tasks[0]!.links).toEqual([{ workItemId: 'WI-1', workItemHarness: 'papercusp', relation: 'for' }]);
  });

  it('returns precise validation codes for invalid transitions and fields', () => {
    expectCode(() => reduce([task({ status: 'completed' })], { op: 'start', taskId: 'task-a' }), 'task_terminal');
    expectCode(() => reduce([task()], { op: 'unblock', taskId: 'task-a' }), 'task_not_blocked');
    expectCode(() => reduce([task()], { op: 'block', taskId: 'task-a' }), 'blocker_ref_required');
    expectCode(
      () => reduce([task()], { op: 'block', taskId: 'task-a', blockerRef: 'event:' }),
      'blocker_ref_target_required',
    );
    expectCode(
      () =>
        reduce([], {
        op: 'init',
        tasks: [{ content: 'Blocked', status: 'blocked', blockerRef: 'plan:P-4' }],
      }),
      'blocker_ref_plan_invalid',
    );
    expectCode(() => reduce([task()], { op: 'view', explanation: 'not allowed' }), 'view_fields_unexpected');
    expectCode(() => reduce([task()], { op: 'done', taskId: 'missing' }), 'task_not_found');
    expectCode(
      () => reduce([task()], { op: 'done', taskId: 'task-a', content: 'silently ignored before' }),
      'done_fields_unexpected',
    );
    expectCode(
      () =>
        reduce([task()], {
        taskId: 'task-a',
        blockerRef: 'wi:WI-1',
        content: 'ambiguous extra field',
      }),
      'block_fields_unexpected',
    );
    expectCode(() => reduce([task()], { op: 'reopen', taskId: 'task-a' }), 'task_not_terminal');
    expectCode(() => reduce([task()], { op: 'reorder', taskId: 'task-a', position: 2 }), 'position_invalid');
  });
});
