import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  diskEntries: [] as Array<{ path: string; mtimeMs: number; sizeBytes: number }>,
  catalogCalls: 0,
  ageCalls: 0,
  diskCalls: 0,
}));

function makeSql() {
  const sql: unknown = (strings: TemplateStringsArray) => {
    const query = Array.from(strings).join(' ');
    if (query.includes('pg_total_relation_size')) {
      h.catalogCalls += 1;
      return Promise.resolve([{ total_bytes: 1000n, rows_estimate: 100n }]);
    }
    return Promise.resolve([{ total: 80n, d30: 50n, d90: 30n, d365: 10n }]);
  };
  const s = sql as {
    unsafe: (q: string) => Promise<unknown[]>;
    begin: (fn: (x: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  s.unsafe = (q: string) => {
    if (q.includes('SET LOCAL')) return Promise.resolve([]);
    h.ageCalls += 1;
    return Promise.resolve([{ total: 80n, d30: 50n, d90: 30n, d365: 10n }]);
  };
  s.begin = (fn) => fn(sql);
  return sql;
}

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: makeSql() }),
}));
vi.mock('./disk', () => ({
  listDiskEntries: () => h.diskEntries,
  // computeStorageUsage now walks disk via the event-loop-cooperative async twin
  // (WI-5471); the sync export stays mocked for any direct caller.
  listDiskEntriesAsync: () => {
    h.diskCalls += 1;
    return Promise.resolve(h.diskEntries);
  },
}));

import { computeStorageUsage, sumStorageUsageTotalBytes, TRIM_THRESHOLD_DAYS } from './usage';
import { STORAGE_CATEGORIES } from './categories';

beforeEach(() => {
  h.catalogCalls = 0;
  h.ageCalls = 0;
  h.diskCalls = 0;
  const now = Date.now();
  h.diskEntries = [
    { path: '/d/old', mtimeMs: now - 400 * 86400000, sizeBytes: 700 },
    { path: '/d/fresh', mtimeMs: now - 5 * 86400000, sizeBytes: 300 },
  ];
});

describe('computeStorageUsage', () => {
  it('returns one row per category', async () => {
    const rows = await computeStorageUsage();
    expect(rows.length).toBe(STORAGE_CATEGORIES.length);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('trimmable PG rows carry a cumulative distribution incl. a null=total bucket', async () => {
    const rows = await computeStorageUsage();
    const route = rows.find((r) => r.id === 'route-invocations')!;
    expect(route.trimmable).toBe(true);
    expect(route.totalBytes).toBe(1000);
    // one bucket per threshold + the total bucket
    expect(route.ageBuckets.length).toBe(TRIM_THRESHOLD_DAYS.length + 1);
    expect(route.ageBuckets.at(-1)!.olderThanDays).toBeNull();
    const b90 = route.ageBuckets.find((b) => b.olderThanDays === 90)!;
    expect(b90.rows).toBe(30);
    // perRow = 1000/80 → 30 rows ≈ 375 bytes
    expect(b90.bytes).toBe(Math.round((1000 / 80) * 30));
  });

  it('federated rows are read-only with no distribution', async () => {
    const rows = await computeStorageUsage();
    const plans = rows.find((r) => r.id === 'plans')!;
    expect(plans.trimmable).toBe(false);
    expect(plans.ageBuckets).toEqual([]);
  });

  it('disk rows size + bucket by mtime', async () => {
    const rows = await computeStorageUsage();
    const scratch = rows.find((r) => r.id === 'scratch')!;
    expect(scratch.kind).toBe('disk');
    expect(scratch.totalBytes).toBe(1000); // 700 + 300
    const b365 = scratch.ageBuckets.find((b) => b.olderThanDays === 365)!;
    expect(b365.rows).toBe(1); // only the 400-day entry
    expect(b365.bytes).toBe(700);
  });

  it('prioritizes scratch before PG reads can exhaust the shared deadline and preserves output order', async () => {
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(100);
    try {
      const rows = await computeStorageUsage({ deadlineMs: 50 });
      expect(rows.find((r) => r.id === 'scratch')?.totalBytes).toBe(1000);
      expect(rows.find((r) => r.kind === 'pg')?.totalBytes).toBeNull();
      expect(rows.map((r) => r.id)).toEqual(STORAGE_CATEGORIES.map((r) => r.id));
    } finally {
      clock.mockRestore();
    }
  });

  it('uses one aggregate deadline and preserves partial rows when it is already exhausted', async () => {
    const rows = await computeStorageUsage({ deadlineMs: Date.now() - 1 });

    expect(rows).toHaveLength(STORAGE_CATEGORIES.length);
    expect(rows.every((row) => row.note?.includes('storage usage read deadline exhausted'))).toBe(true);
    expect(rows.every((row) => row.totalBytes === null)).toBe(true);
    expect(h.catalogCalls).toBe(0);
    expect(h.ageCalls).toBe(0);
  });

  it('measures only the requested category and skips unrelated disk scans', async () => {
    const rows = await computeStorageUsage({ categoryId: 'tool-invocations' });

    expect(rows.map((row) => row.id)).toEqual(['tool-invocations']);
    expect(h.catalogCalls).toBe(1);
    expect(h.ageCalls).toBe(1);
    expect(h.diskCalls).toBe(0);
  });

  it('rejects an unknown requested category instead of returning an empty success', async () => {
    await expect(computeStorageUsage({ categoryId: 'unknown-category' })).rejects.toThrow(
      'Unknown storage category: unknown-category',
    );
  });

  it('does not report a numeric aggregate when one category size is unknown', () => {
    expect(sumStorageUsageTotalBytes([{ totalBytes: 100 }, { totalBytes: null }])).toBeNull();
    expect(sumStorageUsageTotalBytes([{ totalBytes: 100 }, { totalBytes: 25 }])).toBe(125);
  });
});
