import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Sql } from 'postgres';
import { readHiveThroughputSnapshot, isUndefinedTable } from './learning-hive-throughput-read';

/**
 * learning-hive-throughput-read — the Learning tab's Throughput reader
 * (queen-autonomous-execution B-11 / P-050). The PG seam is an injected Sql, so
 * the tests stub the tagged-template call and pin the contracts that matter:
 *   - grouping recent ticks into per-hive views (latest + trend);
 *   - the operating-well verdict over the latest tick (the health tone);
 *   - attention ordering (a stuck/starved hive sorts first);
 *   - BEST-EFFORT: a pre-migration substrate (42P01) degrades to the empty
 *     snapshot silently; any other read error warns + empties.
 */

type Handler = () => Promise<Array<Record<string, unknown>>>;

function fakeSql(ticks: Handler): Sql {
  const fn = (strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const text = strings.join(' ');
    if (text.includes('hive_throughput_ticks')) return ticks();
    return Promise.resolve([]); // nested conditional sql`` fragments
  };
  return fn as unknown as Sql;
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hive_slug: 'papercup',
    tick_at: new Date('2026-06-13T08:00:00Z'),
    frontier_depth: 3,
    placements: 2,
    bees_busy: 4,
    bees_cap: 16,
    stuck_count: 0,
    completed: 1,
    mttc_ms: 120000,
    question_rungs: {},
    detail: { utilization: 0.25 },
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('readHiveThroughputSnapshot', () => {
  it('groups ticks by hive: latest cards + recent trend, newest-first', async () => {
    const sql = fakeSql(async () => [
      row({ hive_slug: 'papercup', tick_at: new Date('2026-06-13T08:01:00Z'), frontier_depth: 1 }),
      row({ hive_slug: 'papercup', tick_at: new Date('2026-06-13T08:00:00Z'), frontier_depth: 3 }),
    ]);
    const snap = await readHiveThroughputSnapshot(sql, 'ws-1');
    expect(snap.hives).toHaveLength(1);
    const h = snap.hives[0]!;
    expect(h.hiveSlug).toBe('papercup');
    expect(h.latest?.frontierDepth).toBe(1); // newest tick
    expect(h.recent).toHaveLength(2);
    expect(h.operatingWell).toBe(true); // slack fleet, no stuck
    expect(h.latest?.mttcMs).toBe(120000);
    expect(h.latest?.utilization).toBe(0.25);
  });

  it('separates multiple hives and orders attention-first (stuck/starved before healthy)', async () => {
    const sql = fakeSql(async () => [
      // healthy hive
      row({ hive_slug: 'alpha', stuck_count: 0, bees_busy: 2, bees_cap: 16, frontier_depth: 0 }),
      // starved hive (busy == cap, work queued) → utilization derives to 1
      row({ hive_slug: 'zeta', stuck_count: 0, bees_busy: 8, bees_cap: 8, frontier_depth: 5, detail: null }),
    ]);
    const snap = await readHiveThroughputSnapshot(sql, 'ws-1');
    expect(snap.hives.map((h) => h.hiveSlug)).toEqual(['zeta', 'alpha']); // attention-first
    expect(snap.hives.find((h) => h.hiveSlug === 'zeta')?.operatingWell).toBe(false);
    expect(snap.hives.find((h) => h.hiveSlug === 'alpha')?.operatingWell).toBe(true);
  });

  it('a stuck latest tick fails operating-well', async () => {
    const sql = fakeSql(async () => [row({ hive_slug: 'papercup', stuck_count: 2 })]);
    const snap = await readHiveThroughputSnapshot(sql, 'ws-1');
    expect(snap.hives[0]?.operatingWell).toBe(false);
  });

  it('empty when no ticks recorded', async () => {
    const snap = await readHiveThroughputSnapshot(fakeSql(async () => []), 'ws-1');
    expect(snap).toEqual({ hives: [] });
  });

  it('degrades to the empty snapshot SILENTLY when the table does not exist yet (42P01)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql(async () => {
      throw Object.assign(new Error('relation "harness_shared.hive_throughput_ticks" does not exist'), { code: '42P01' });
    });
    const snap = await readHiveThroughputSnapshot(sql, 'ws-1');
    expect(snap).toEqual({ hives: [] });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns + empties on any other read error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql(async () => {
      throw Object.assign(new Error('permission denied'), { code: '42501' });
    });
    const snap = await readHiveThroughputSnapshot(sql, 'ws-1');
    expect(snap).toEqual({ hives: [] });
    expect(warn).toHaveBeenCalled();
  });
});

describe('isUndefinedTable', () => {
  it('matches only SQLSTATE 42P01', () => {
    expect(isUndefinedTable(Object.assign(new Error('x'), { code: '42P01' }))).toBe(true);
    expect(isUndefinedTable(Object.assign(new Error('x'), { code: '42703' }))).toBe(false);
    expect(isUndefinedTable(null)).toBe(false);
  });
});
