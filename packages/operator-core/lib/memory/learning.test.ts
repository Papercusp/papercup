/**
 * learning.test.ts — the memory-feedback learning loop (task #36 hardening).
 * learning.ts had NO test. It feeds mem0's extraction prompt with a derived
 * `customInstructions` string, so two invariants matter for a public release:
 *
 *  1. DEGRADE-NEVER-THROW: buildLearningInstructions is wrapped so ANY failure
 *     (no pg fields, connect refused, table missing, query error) returns null —
 *     mem0 then uses its stock prompt. It must never throw and break extraction.
 *     The pg CONNECTION is also always released (finally) even when the query throws.
 *  2. AGGREGATION MAPPING (the subtle bit): forget_all folds into totalDeletes AND
 *     forgetAllCount but is EXCLUDED from byKind; a null-kind delete counts toward
 *     totalDeletes but not per-kind. rebuildCustomInstructions (tested separately in
 *     learning-shared.test.ts) is mocked here to a spy so we assert the exact shape
 *     learning.ts hands it.
 *
 * Run: cd packages/operator-core && npx vitest run lib/memory/learning.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pgClientFields: vi.fn(),
  connect: vi.fn(async () => {}),
  query: vi.fn(async () => ({ rows: [] as Array<{ action: string; kind: string | null; n: number }> })),
  end: vi.fn(async () => {}),
  rebuild: vi.fn(() => 'STOCK+DERIVED-INSTRUCTIONS'),
}));

vi.mock('./mem0-connection', () => ({ pgClientFields: mocks.pgClientFields }));
vi.mock('pg', () => ({
  Client: class {
    constructor(_fields: unknown) {}
    connect() {
      return mocks.connect();
    }
    query(q: unknown) {
      return mocks.query(q as never);
    }
    end() {
      return mocks.end();
    }
  },
}));
vi.mock('./learning-shared', () => ({ rebuildCustomInstructions: mocks.rebuild }));

import { buildLearningInstructions } from './learning';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pgClientFields.mockResolvedValue({ host: 'localhost', database: 'mem0' });
  mocks.connect.mockResolvedValue(undefined);
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.end.mockResolvedValue(undefined);
  mocks.rebuild.mockReturnValue('STOCK+DERIVED-INSTRUCTIONS');
});

describe('buildLearningInstructions — degrade-never-throw (a broken learning loop must not break extraction)', () => {
  it('returns null when there are no pg connection fields (mem0 not on Postgres)', async () => {
    mocks.pgClientFields.mockResolvedValue(null);
    await expect(buildLearningInstructions()).resolves.toBeNull();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('returns null (never throws) when connect is refused', async () => {
    mocks.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(buildLearningInstructions()).resolves.toBeNull();
  });

  it('returns null when the feedback query throws — AND releases the connection (finally)', async () => {
    mocks.query.mockRejectedValue(new Error('relation "harness_shared.memory_feedback" does not exist'));
    await expect(buildLearningInstructions()).resolves.toBeNull();
    expect(mocks.end).toHaveBeenCalledTimes(1); // connection not leaked on query failure
  });
});

describe('buildLearningInstructions — aggregation mapping into rebuildCustomInstructions', () => {
  const rows = [
    { action: 'edit', kind: 'project', n: 5 },
    { action: 'edit', kind: 'user', n: 2 },
    { action: 'delete', kind: 'feedback', n: 4 },
    { action: 'delete', kind: null, n: 1 }, // null-kind delete: totals only, not byKind
    { action: 'forget_all', kind: null, n: 3 }, // folds into totalDeletes + forgetAllCount, NOT byKind
  ];

  it('sums totals, folds forget_all into deletes, and keeps byKind free of forget_all / null kinds', async () => {
    mocks.query.mockResolvedValue({ rows });
    const out = await buildLearningInstructions();

    expect(out).toBe('STOCK+DERIVED-INSTRUCTIONS'); // returns whatever rebuild produced
    expect(mocks.rebuild).toHaveBeenCalledTimes(1);
    const arg = mocks.rebuild.mock.calls[0][0] as {
      totalEdits: number; totalDeletes: number; forgetAllCount: number;
      byKind: { edit: Record<string, number>; delete: Record<string, number> }; noiseFloor: number;
    };
    expect(arg.totalEdits).toBe(7); // 5 + 2
    expect(arg.totalDeletes).toBe(8); // delete 4 + delete(null) 1 + forget_all 3
    expect(arg.forgetAllCount).toBe(3);
    expect(arg.byKind).toEqual({ edit: { project: 5, user: 2 }, delete: { feedback: 4 } });
    expect(arg.noiseFloor).toBe(3);
    expect(mocks.end).toHaveBeenCalledTimes(1); // connection released on the happy path too
  });

  it('empty feedback still calls rebuild with zeroed totals (rebuild decides null on no signal)', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await buildLearningInstructions();
    const arg = mocks.rebuild.mock.calls[0][0] as { totalEdits: number; totalDeletes: number; forgetAllCount: number };
    expect(arg.totalEdits).toBe(0);
    expect(arg.totalDeletes).toBe(0);
    expect(arg.forgetAllCount).toBe(0);
  });
});
