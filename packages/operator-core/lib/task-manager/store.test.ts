import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { getTask } from './store';

function fakeSql(row: Record<string, unknown>): Sql {
  return (async () => [row]) as unknown as Sql;
}

describe('task-manager/store row mapping', () => {
  it('parses JSONB detail when the worker returns it as a string', async () => {
    const row = await getTask(
      'task-json-detail',
      fakeSql({
        task_id: 'task-json-detail',
        workspace_id: 'workspace-1',
        root_task_id: 'task-json-detail',
        class: 'bash-job',
        title: 'background task',
        argv: '[]',
        launched_by: 'test',
        confined: true,
        state: 'exited',
        detail: JSON.stringify({ bashJobId: 'bash-json-detail' }),
      }),
    );

    expect(row?.detail).toEqual({ bashJobId: 'bash-json-detail' });
  });

  it('uses an empty object for malformed or non-object detail', async () => {
    const malformed = await getTask(
      'task-bad-detail',
      fakeSql({
        task_id: 'task-bad-detail',
        workspace_id: 'workspace-1',
        root_task_id: 'task-bad-detail',
        class: 'bash-job',
        title: 'background task',
        argv: [],
        launched_by: 'test',
        confined: true,
        state: 'running',
        detail: '{not-json',
      }),
    );
    const array = await getTask(
      'task-array-detail',
      fakeSql({
        task_id: 'task-array-detail',
        workspace_id: 'workspace-1',
        root_task_id: 'task-array-detail',
        class: 'bash-job',
        title: 'background task',
        argv: [],
        launched_by: 'test',
        confined: true,
        state: 'running',
        detail: '[]',
      }),
    );

    expect(malformed?.detail).toEqual({});
    expect(array?.detail).toEqual({});
  });
});
