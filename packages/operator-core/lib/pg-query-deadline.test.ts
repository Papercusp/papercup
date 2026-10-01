import { describe, expect, it, vi } from 'vitest';
import { pgReadQuery, explainReadQuery, PgReadQueryTimeoutError, PG_READ_QUERY_CALL_OVERHEAD_MS } from './pg-read-query';
import { pgMutateQuery } from './pg-mutate-query';
import { DEPENDENCY_QUERY_TIMEOUT_MS, readDependencyBottlenecks } from './dependency-traversal';

// Pure lifecycle regressions: no filesystem census or process spawn.
describe('PG query deadline continuation', () => {
  it('honors the monotonic deadline before a delayed timer can run', async () => {
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const unsafe = vi.fn(async (_sql: string) => []);
      let resumeTransaction!: () => Promise<void>;
      const client = {
        begin: (fn: (tx: { unsafe: typeof unsafe }) => Promise<void>) =>
          new Promise<void>((resolve, reject) => {
            resumeTransaction = async () => { await fn({ unsafe }).then(resolve, reject); };
          }),
      } as never;
      const call = pgReadQuery('SELECT 1', { client, timeoutMs: 100 });
      const assertion = expect(call).rejects.toBeInstanceOf(PgReadQueryTimeoutError);
      // No timer advance: this is the microtask-before-overdue-timer case.
      clock.mockReturnValue(PG_READ_QUERY_CALL_OVERHEAD_MS + 101);
      await resumeTransaction();
      await assertion;
      expect(unsafe).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['statement', 'audit'] as const)('rolls back when a mutation %s finishes after the caller expired', async (stage) => {
    vi.useFakeTimers();
    try {
      let resumeStatement!: () => void;
      const state = { committed: false, rolledBack: false };
      const unsafe = vi.fn(async (sql: string) => {
        const rows = Object.assign([{ id: 1 }], { count: 1 });
        if ((stage === 'statement' && sql.startsWith('DELETE'))
          || (stage === 'audit' && sql.startsWith('INSERT INTO harness_shared.audit_log'))) {
          return new Promise<typeof rows>((resolve) => { resumeStatement = () => resolve(rows); });
        }
        return rows;
      });
      const client = {
        begin: async (fn: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => {
          try {
            const result = await fn({ unsafe });
            state.committed = true;
            return result;
          } catch (error) {
            state.rolledBack = true;
            throw error;
          }
        },
      } as never;
      const call = pgMutateQuery('DELETE FROM t WHERE id = 1', {
        client, timeoutMs: 100, audit: { actor: 'private-test', reason: 'deadline regression', workspaceId: 'private-test' },
      });
      const assertion = expect(call).rejects.toBeInstanceOf(PgReadQueryTimeoutError);
      await vi.advanceTimersByTimeAsync(PG_READ_QUERY_CALL_OVERHEAD_MS + 101);
      await assertion;
      resumeStatement();
      await vi.advanceTimersByTimeAsync(0);
      expect(state).toEqual({ committed: false, rolledBack: true });
      if (stage === 'statement') {
        expect(unsafe.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO harness_shared.audit_log'))).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['read', 'explain', 'mutate', 'dependency'] as const)('does not start a late %s transaction after its caller timed out', async (mode) => {
    vi.useFakeTimers();
    try {
      const unsafe = vi.fn(async (_sql: string) => []);
      let resumeTransaction!: () => Promise<void>;
      const client = {
        begin: (fn: (tx: { unsafe: typeof unsafe }) => Promise<void>) =>
          new Promise<void>((resolve, reject) => {
            resumeTransaction = async () => {
              await fn({ unsafe }).then(resolve, reject);
            };
          }),
      } as never;
      const timeoutMs = 100;
      const budget = mode === 'dependency' ? DEPENDENCY_QUERY_TIMEOUT_MS : timeoutMs;
      const call = {
        read: () => pgReadQuery('SELECT 1', { client, timeoutMs }),
        explain: () => explainReadQuery('SELECT 1', { client, timeoutMs }),
        mutate: () => pgMutateQuery('DELETE FROM t WHERE id = 1', { client, timeoutMs }),
        dependency: () => readDependencyBottlenecks(
          { workspaceId: 'private-test', harnessSlug: 'test', planSlug: 'test' }, { client },
        ),
      }[mode]();
      const settled = call.then((result) => result, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(budget + PG_READ_QUERY_CALL_OVERHEAD_MS + 1);
      const result = await settled;
      if (mode !== 'explain') expect(result).toBeInstanceOf(PgReadQueryTimeoutError);
      else expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('WHOLE call') } });

      await resumeTransaction();
      expect(unsafe).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start the target scan after a positive control outlives the call deadline', async () => {
    vi.useFakeTimers();
    try {
      const queries: string[] = [];
      let resumeControl!: () => void;
      const client = {
        begin: async (fn: (tx: { unsafe: (sql: string) => Promise<unknown> }) => Promise<void>) =>
          fn({
            unsafe: async (sql) => {
              queries.push(sql);
              if (sql.includes('_pgq_positive_control')) {
                return new Promise((resolve) => { resumeControl = () => resolve([{ known: 1 }]); });
              }
              return [];
            },
          }),
      } as never;
      const timeoutMs = 100;
      const call = pgReadQuery('SELECT 1 AS target', { client, timeoutMs, positiveControlSql: 'SELECT 1 AS known' });
      const assertion = expect(call).rejects.toBeInstanceOf(PgReadQueryTimeoutError);
      await vi.advanceTimersByTimeAsync(timeoutMs + PG_READ_QUERY_CALL_OVERHEAD_MS + 1);
      await assertion;
      expect(queries.some((query) => query.includes('_pgq_positive_control'))).toBe(true);
      resumeControl();
      await vi.advanceTimersByTimeAsync(0);
      expect(queries.some((query) => query.includes('AS _pgq LIMIT'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

});
