import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  diskEntries: [] as Array<{ path: string; mtimeMs: number; sizeBytes: number }>,
}));

function makeSql() {
  const sql: unknown = () => Promise.resolve([{ total_bytes: 1000n, rows_estimate: 100n }]);
  const s = sql as { unsafe: (q: string) => Promise<unknown[]>; begin: (fn: (x: unknown) => Promise<unknown>) => Promise<unknown> };
  s.unsafe = (q: string) => {
    if (q.includes('SET LOCAL')) return Promise.resolve([]);
    return Promise.resolve([{ total: 80n, d30: 50n, d90: 30n, d365: 10n }]);
  };
  s.begin = (fn) => fn(sql);
  return sql;
}

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: makeSql() }) }));
vi.mock('./disk', () => ({
  listDiskEntries: () => h.diskEntries,
}));

import { computeStorageUsage, TRIM_THRESHOLD_DAYS } from './usage';
import { STORAGE_CATEGORIES } from './categories';

beforeEach(() => {
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
});
