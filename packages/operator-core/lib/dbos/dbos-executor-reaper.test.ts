import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { reapDeadExecutorWorkflows } from './dbos-executor-reaper';

type Call = { text: string; values: unknown[] };

function fakeSql(handler: (text: string, values: unknown[]) => unknown) {
  const calls: Call[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.from(strings).join('?');
    calls.push({ text, values });
    return handler(text, values);
  }) as unknown as Sql;
  return { sql, calls };
}

describe('reapDeadExecutorWorkflows', () => {
  it('reaps stale routinesTick rows even when the stable executor id has fresh activity', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [];
      if (text.includes('SELECT workflow_uuid')) return [{ workflow_uuid: 'sched-.routinesTick-old' }];
      if (text.includes('UPDATE dbos.workflow_status') && text.includes('workflow_uuid = ANY')) return { count: 1 };
      if (text.includes('DELETE FROM dbos.workflow_queue') && text.includes('workflow_uuid = ANY')) return { count: 1 };
      throw new Error(`unexpected query: ${text}`);
    });

    const res = await reapDeadExecutorWorkflows(sql, 300_000, 90_000);

    expect(res).toEqual({
      cancelled: 1,
      queuePurged: 1,
      deadExecutorIds: [],
      staleWorkflowIds: ['sched-.routinesTick-old'],
    });
    const staleSelect = calls.find((c) => c.text.includes('SELECT workflow_uuid'))!;
    expect(staleSelect.text).toContain("name = 'routinesTick'");
    expect(staleSelect.text).toContain('workflow_deadline_epoch_ms');
  });

  it('preserves the original dead-executor reap path and reports both classes', async () => {
    const { sql } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [{ executor_id: 'dead-exec' }];
      if (text.includes('UPDATE dbos.workflow_status') && text.includes('executor_id = ANY')) return { count: 2 };
      if (text.includes('DELETE FROM dbos.workflow_queue') && text.includes('executor_id = ANY')) return { count: 2 };
      if (text.includes('SELECT workflow_uuid')) return [{ workflow_uuid: 'expired-fire' }];
      if (text.includes('UPDATE dbos.workflow_status') && text.includes('workflow_uuid = ANY')) return { count: 1 };
      if (text.includes('DELETE FROM dbos.workflow_queue') && text.includes('workflow_uuid = ANY')) return { count: 1 };
      throw new Error(`unexpected query: ${text}`);
    });

    const res = await reapDeadExecutorWorkflows(sql);

    expect(res.cancelled).toBe(3);
    expect(res.queuePurged).toBe(3);
    expect(res.deadExecutorIds).toEqual(['dead-exec']);
    expect(res.staleWorkflowIds).toEqual(['expired-fire']);
  });

  it('fails soft and returns an empty result if the reap query errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sql } = fakeSql(() => {
      throw new Error('pg unavailable');
    });

    await expect(reapDeadExecutorWorkflows(sql)).resolves.toEqual({
      cancelled: 0,
      queuePurged: 0,
      deadExecutorIds: [],
      staleWorkflowIds: [],
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
