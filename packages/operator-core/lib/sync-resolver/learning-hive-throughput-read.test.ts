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
    if (text.includes('pot_throughput_ticks')) return ticks();
    return Promise.resolve([]); // nested conditional sql`` fragments
  };
  return fn as unknown as Sql;
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pot_slug: 'papercup',
    tick_at: new Date('2026-06-13T08:00:00Z'),
    frontier_depth: 3,
    placements: 2,
    cups_busy: 4,
    cups_cap: 16,
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
      row({ pot_slug: 'papercup', tick_at: new Date('2026-06-13T08:01:00Z'), frontier_depth: 1 }),
      row({ pot_slug: 'papercup', tick_at: new Date('2026-06-13T08:00:00Z'), frontier_depth: 3 }),
    ]);
    const snap = await readHiveThroughputSnapshot(sql, 'ws-1');
    expect(snap.hives).toHaveLength(1);
    const h = snap.hives[0]!;
    expect(h.potSlug).toBe('papercup');
    expect(h.latest?.frontierDepth).toBe(1); // newest tick
    expect(h.recent).toHaveLength(2);
    expect(h.operatingWell).toBe(true); // slack fleet, no stuck
    expect(h.latest?.mttcMs).toBe(120000);
    expect(h.latest?.utilization).toBe(0.25);
  });

  it('separates multiple hives and orders attention-first (stuck/starved before healthy)', async () => {
    const sql = fakeSql(async () => [
      // healthy hive
      row({ pot_slug: 'alpha', stuck_count: 0, cups_busy: 2, cups_cap: 16, frontier_depth: 0 }),
      // starved hive (busy == cap, work queued) → utilization derives to 1
      row({ pot_slug: 'zeta', stuck_count: 0, cups_busy: 8, cups_cap: 8, frontier_depth: 5, detail: null }),
    ]);
    const snap = await readHiveThroughputSnapshot(sql, 'ws-1');
    expect(snap.hives.map((h) => h.potSlug)).toEqual(['zeta', 'alpha']); // attention-first
    expect(snap.hives.find((h) => h.potSlug === 'zeta')?.operatingWell).toBe(false);
    expect(snap.hives.find((h) => h.potSlug === 'alpha')?.operatingWell).toBe(true);
  });

  it('a stuck latest tick fails operating-well', async () => {
    const sql = fakeSql(async () => [row({ pot_slug: 'papercup', stuck_count: 2 })]);
    const snap = await readHiveThroughputSnapshot(sql, 'ws-1');
    expect(snap.hives[0]?.operatingWell).toBe(false);
  });

  // WI-6382: an OBSERVED empty carries no provenance — this is the one case
  // where "nothing recorded yet" is the truth, and the panel's calm empty state
  // is the correct render. It is the CONTRAST case for the two below.
  it('empty when no ticks recorded — and NOT flagged unavailable', async () => {
    const snap = await readHiveThroughputSnapshot(fakeSql(async () => []), 'ws-1');
    expect(snap).toEqual({ hives: [] });
    expect(snap.unavailable).toBeUndefined();
  });

  // These two used to assert `toEqual({ hives: [] })` — i.e. they asserted that
  // a failed read is INDISTINGUISHABLE from an idle healthy one, and so actively
  // enshrined WI-6382. Changing them is the fix, not a regression: the degraded
  // snapshot must now say WHY, or the panel goes on telling the user "no
  // throughput recorded yet — start a pot and its metrics appear here" while
  // the substrate is missing or unreadable.
  it('degrades with pre-migration provenance when the table does not exist yet (42P01)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql(async () => {
      throw Object.assign(new Error('relation "harness_shared.pot_throughput_ticks" does not exist'), { code: '42P01' });
    });
    const snap = await readHiveThroughputSnapshot(sql, 'ws-1');
    expect(snap.hives).toEqual([]);
    // Still not a 500, and still not noisy — pre-migration is expected.
    expect(warn).not.toHaveBeenCalled();
    // But no longer a LIE: distinguishable from the observed-empty case above.
    expect(snap.unavailable).toBe(true);
    expect(snap.unavailableKind).toBe('pre-migration');
    expect(snap.unavailableReason).toContain('does not exist');
  });

  it('degrades with read-failed provenance (and warns) on any other read error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql(async () => {
      throw Object.assign(new Error('permission denied'), { code: '42501' });
    });
    const snap = await readHiveThroughputSnapshot(sql, 'ws-1');
    expect(snap.hives).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect(snap.unavailable).toBe(true);
    expect(snap.unavailableKind).toBe('read-failed');
    // The CAUSE, verbatim — a bare "unavailable" is a dead end for the reader.
    expect(snap.unavailableReason).toBe('permission denied');
  });

  // The property the whole WI reduces to, stated once as an executable claim.
  it('an observed empty and a degraded empty are DIFFERENT VALUES', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const observed = await readHiveThroughputSnapshot(fakeSql(async () => []), 'ws-1');
    const degradedSnap = await readHiveThroughputSnapshot(
      fakeSql(async () => {
        throw Object.assign(new Error('boom'), { code: '42501' });
      }),
      'ws-1',
    );
    expect(observed.hives).toEqual(degradedSnap.hives); // same DATA …
    expect(observed).not.toEqual(degradedSnap); // … different FACT.
  });
});

describe('isUndefinedTable', () => {
  it('matches only SQLSTATE 42P01', () => {
    expect(isUndefinedTable(Object.assign(new Error('x'), { code: '42P01' }))).toBe(true);
    expect(isUndefinedTable(Object.assign(new Error('x'), { code: '42703' }))).toBe(false);
    expect(isUndefinedTable(null)).toBe(false);
  });
});
