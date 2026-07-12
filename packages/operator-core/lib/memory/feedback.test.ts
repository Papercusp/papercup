/**
 * feedback.test.ts — memory-feedback signal capture (task #36 hardening).
 * feedback.ts had NO test. It records every user-driven memory mutation
 * (create/edit/delete/forget_all) into harness_shared.memory_feedback — the
 * raw learning signal the extraction loop later derives instructions from
 * (see learning.ts). Two invariants matter for a public release:
 *
 *  1. BEST-EFFORT / DEGRADE-NEVER-THROW: a user-facing memory op must NEVER
 *     fail because feedback capture failed. No pg fields, connect refused,
 *     query error → recordFeedback resolves (swallowed) and loadFeedbackStats
 *     returns null. The pg connection is ALWAYS released (finally) even when
 *     the query throws — no leak on the failure path.
 *  2. AGGREGATION MAPPING (the subtle bit, mirrored from learning.ts):
 *     total_deletes folds BOTH `delete` AND `forget_all`; a missing action
 *     bucket defaults to 0, never NaN/undefined. And the INSERT maps the 7
 *     columns in order with nullish `kind/priorText/newText` → SQL NULL.
 *
 * Run: cd packages/operator-core && npx vitest run lib/memory/feedback.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pgClientFields: vi.fn(),
  activeWorkspaceId: vi.fn(() => 'ws-1'),
  connect: vi.fn(async () => {}),
  end: vi.fn(async () => {}),
  query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as Array<Record<string, unknown>> })),
  calls: [] as Array<{ sql: string; params?: unknown[] }>,
}));

vi.mock('../workspace-registry', () => ({ activeWorkspaceId: mocks.activeWorkspaceId }));
vi.mock('./mem0-connection', () => ({ pgClientFields: mocks.pgClientFields }));
vi.mock('pg', () => ({
  Client: class {
    constructor(_fields: unknown) {}
    connect() {
      return mocks.connect();
    }
    query(sql: unknown, params?: unknown[]) {
      mocks.calls.push({ sql: String(sql), params });
      return mocks.query(sql as string, params);
    }
    end() {
      return mocks.end();
    }
  },
}));

import { recordFeedback, loadFeedbackStats } from './feedback';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls = [];
  mocks.pgClientFields.mockResolvedValue({ host: 'localhost', database: 'mem0' });
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
  mocks.activeWorkspaceId.mockReturnValue('ws-1');
  mocks.query.mockResolvedValue({ rows: [] });
});

describe('recordFeedback — best-effort (a memory op must never fail because capture failed)', () => {
  it('returns early without connecting when mem0 is not on Postgres (no pg fields)', async () => {
    mocks.pgClientFields.mockResolvedValue(null);
    await expect(recordFeedback({ memId: 'm1', userId: 'u1', action: 'edit' })).resolves.toBeUndefined();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('inserts one row mapping the 7 columns in order (workspace from activeWorkspaceId)', async () => {
    await recordFeedback({
      memId: 'm1', userId: 'u1', action: 'edit',
      kind: 'project', priorText: 'before', newText: 'after',
    });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const { sql, params } = mocks.calls[0];
    expect(sql).toContain('INSERT INTO harness_shared.memory_feedback');
    expect(params).toEqual(['m1', 'u1', 'ws-1', 'edit', 'project', 'before', 'after']);
    expect(mocks.end).toHaveBeenCalledTimes(1); // connection released on the happy path
  });

  it('coerces missing kind/priorText/newText to SQL NULL (never undefined)', async () => {
    await recordFeedback({ memId: 'm2', userId: 'u2', action: 'forget_all' });
    const { params } = mocks.calls[0];
    expect(params).toEqual(['m2', 'u2', 'ws-1', 'forget_all', null, null, null]);
  });

  it('SWALLOWS a query error AND still releases the connection (finally) — never throws', async () => {
    mocks.query.mockRejectedValue(new Error('relation "harness_shared.memory_feedback" does not exist'));
    await expect(recordFeedback({ memId: 'm1', userId: 'u1', action: 'delete' })).resolves.toBeUndefined();
    expect(mocks.end).toHaveBeenCalledTimes(1); // connection not leaked on query failure
  });

  it('swallows a connect failure (resolves, never rejects)', async () => {
    mocks.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(recordFeedback({ memId: 'm1', userId: 'u1', action: 'create' })).resolves.toBeUndefined();
  });

  it('swallows even a pgClientFields failure', async () => {
    mocks.pgClientFields.mockRejectedValue(new Error('discovery failed'));
    await expect(recordFeedback({ memId: 'm1', userId: 'u1', action: 'edit' })).resolves.toBeUndefined();
  });
});

describe('loadFeedbackStats — aggregation (forget_all folds into deletes; missing buckets → 0)', () => {
  const routed = (counts: Array<{ action: string; n: number }>, recent: Array<Record<string, unknown>> = []) => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('GROUP BY action')) return { rows: counts };
      if (sql.includes('ORDER BY created_at')) return { rows: recent };
      return { rows: [] };
    });
  };

  it('returns null when mem0 is not on Postgres', async () => {
    mocks.pgClientFields.mockResolvedValue(null);
    await expect(loadFeedbackStats('u1')).resolves.toBeNull();
  });

  it('sums edits, and folds BOTH delete and forget_all into total_deletes', async () => {
    routed(
      [{ action: 'edit', n: 5 }, { action: 'delete', n: 3 }, { action: 'forget_all', n: 2 }],
      [{ id: 'f1', mem_id: 'm1', action: 'edit', prior_text: 'a', new_text: 'b', created_at: '2026-07-12T00:00:00Z' }],
    );
    const stats = await loadFeedbackStats('u1');
    expect(stats).not.toBeNull();
    expect(stats!.total_edits).toBe(5);
    expect(stats!.total_deletes).toBe(5); // 3 delete + 2 forget_all
    expect(stats!.recent).toHaveLength(1);
    expect(stats!.recent[0].mem_id).toBe('m1');
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it('a missing action bucket defaults to 0 (never NaN/undefined)', async () => {
    routed([]); // no feedback yet
    const stats = await loadFeedbackStats('u1');
    expect(stats!.total_edits).toBe(0);
    expect(stats!.total_deletes).toBe(0);
    expect(Number.isNaN(stats!.total_deletes)).toBe(false);
    expect(stats!.recent).toEqual([]);
  });

  it('edits with no deletions → total_deletes 0 (neither delete nor forget_all present)', async () => {
    routed([{ action: 'edit', n: 4 }]);
    const stats = await loadFeedbackStats('u1');
    expect(stats!.total_edits).toBe(4);
    expect(stats!.total_deletes).toBe(0);
  });

  it('passes userId + a default recentLimit of 20, overridable per call', async () => {
    routed([], []);
    await loadFeedbackStats('u1');
    const recentCall = mocks.calls.find((c) => c.sql.includes('ORDER BY created_at'))!;
    expect(recentCall.params).toEqual(['u1', 20]);

    mocks.calls = [];
    await loadFeedbackStats('u1', 5);
    const recentCall2 = mocks.calls.find((c) => c.sql.includes('ORDER BY created_at'))!;
    expect(recentCall2.params).toEqual(['u1', 5]);
  });

  it('returns null on a query error AND releases the connection (finally)', async () => {
    mocks.query.mockRejectedValue(new Error('query blew up'));
    await expect(loadFeedbackStats('u1')).resolves.toBeNull();
    expect(mocks.end).toHaveBeenCalledTimes(1); // no leak on the failure path
  });
});
