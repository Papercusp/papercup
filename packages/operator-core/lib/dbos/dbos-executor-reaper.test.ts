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
      requeuedRoutineIds: [],
      deadExecutorIds: [],
      staleWorkflowIds: ['sched-.routinesTick-old'],
    });
    const staleSelect = calls.find((c) => c.text.includes('SELECT workflow_uuid'))!;
    expect(staleSelect.text).toContain("name = 'routinesTick'");
    expect(staleSelect.text).toContain("name = 'routineFire'");
    expect(staleSelect.text).toContain('COALESCE(started_at_epoch_ms, created_at)');
    expect(staleSelect.text).toContain('NOT EXISTS');
    expect(staleSelect.text).toContain('dbos.operation_outputs');
    expect(staleSelect.text).toContain('workflow_deadline_epoch_ms');
  });

  it('reaps stale routineFire rows only when no DBOS operation step has started', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [];
      if (text.includes('SELECT workflow_uuid')) {
        return [{ workflow_uuid: 'sched-.routineFire-no-step', requeue_routine_id: 'rt_scout' }];
      }
      if (text.includes('UPDATE dbos.workflow_status') && text.includes('workflow_uuid = ANY')) return { count: 1 };
      if (text.includes('DELETE FROM dbos.workflow_queue') && text.includes('workflow_uuid = ANY')) return { count: 0 };
      if (text.includes('UPDATE harness_shared.routines')) return { count: 1 };
      throw new Error(`unexpected query: ${text}`);
    });

    const res = await reapDeadExecutorWorkflows(sql, 300_000, 90_000);

    expect(res.cancelled).toBe(1);
    expect(res.staleWorkflowIds).toEqual(['sched-.routineFire-no-step']);
    expect(res.requeuedRoutineIds).toEqual(['rt_scout']);
    const staleSelect = calls.find((c) => c.text.includes('SELECT workflow_uuid'))!;
    expect(staleSelect.text).toContain("name = 'routineFire'");
    expect(staleSelect.text).toContain("deduplication_id LIKE 'routine:%'");
    expect(staleSelect.text).toContain('substring(deduplication_id from 9)');
    expect(staleSelect.text).toContain('op.workflow_uuid = dbos.workflow_status.workflow_uuid');
    const requeueUpdate = calls.find((c) => c.text.includes('UPDATE harness_shared.routines'))!;
    expect(requeueUpdate.text).toContain('next_fire_at = LEAST');
    expect(requeueUpdate.text).toContain('dbos-executor-reaper');
    expect(requeueUpdate.values).toContainEqual(['rt_scout']);
  });

  it('deduplicates requeued routines from multiple no-step routineFire rows', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [];
      if (text.includes('SELECT workflow_uuid')) {
        return [
          { workflow_uuid: 'sched-.routineFire-no-step-a', requeue_routine_id: 'rt_scout' },
          { workflow_uuid: 'sched-.routineFire-no-step-b', requeue_routine_id: 'rt_scout' },
          { workflow_uuid: 'sched-.routineFire-deadline', requeue_routine_id: null },
        ];
      }
      if (text.includes('UPDATE dbos.workflow_status') && text.includes('workflow_uuid = ANY')) return { count: 3 };
      if (text.includes('DELETE FROM dbos.workflow_queue') && text.includes('workflow_uuid = ANY')) return { count: 0 };
      if (text.includes('UPDATE harness_shared.routines')) return { count: 1 };
      throw new Error(`unexpected query: ${text}`);
    });

    const res = await reapDeadExecutorWorkflows(sql, 300_000, 90_000);

    expect(res.cancelled).toBe(3);
    expect(res.requeuedRoutineIds).toEqual(['rt_scout']);
    const requeueUpdate = calls.find((c) => c.text.includes('UPDATE harness_shared.routines'))!;
    expect(requeueUpdate.values).toContainEqual(['rt_scout']);
  });

  it('preserves the original dead-executor reap path and reports both classes', async () => {
    const { sql } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [{ executor_id: 'dead-exec' }];
      if (text.includes('UPDATE dbos.workflow_status') && text.includes('executor_id = ANY')) return { count: 2 };
      if (text.includes('DELETE FROM dbos.workflow_queue') && text.includes('executor_id = ANY')) return { count: 2 };
      if (text.includes('SELECT workflow_uuid')) return [{ workflow_uuid: 'expired-fire', requeue_routine_id: null }];
      if (text.includes('UPDATE dbos.workflow_status') && text.includes('workflow_uuid = ANY')) return { count: 1 };
      if (text.includes('DELETE FROM dbos.workflow_queue') && text.includes('workflow_uuid = ANY')) return { count: 1 };
      throw new Error(`unexpected query: ${text}`);
    });

    const res = await reapDeadExecutorWorkflows(sql);

    expect(res.cancelled).toBe(3);
    expect(res.queuePurged).toBe(3);
    expect(res.requeuedRoutineIds).toEqual([]);
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
      requeuedRoutineIds: [],
      deadExecutorIds: [],
      staleWorkflowIds: [],
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
