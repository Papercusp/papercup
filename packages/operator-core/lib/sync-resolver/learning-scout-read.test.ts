import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Sql } from 'postgres';
import { readScoutSnapshot, normalizeScoutTick, isUndefinedTable } from './learning-scout-read';

/**
 * learning-scout-read — the Learning tab Scout reader (learning-system-audit
 * P-042). The PG seam is an injected Sql, so the tests stub the tagged-template
 * call and pin the two contracts that matter:
 *   - rail aggregation (count-by-rail + total) over scout_routed_ideas;
 *   - the tick half is BEST-EFFORT: scout_ticks may not exist yet (P-034 lands
 *     it separately) — undefined-table silently omits it, any other error warns
 *     + omits, and a present row is normalized across plausible column names.
 */

type Handler = () => Promise<Array<Record<string, unknown>>>;

function fakeSql(opts: { rails?: Handler; items?: Handler; ticks?: Handler }): Sql {
  const fn = (strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const text = strings.join(' ');
    // Both ledger reads hit scout_routed_ideas — the aggregate groups by rail,
    // the per-item read selects idea_id.
    if (text.includes('GROUP BY rail')) return (opts.rails ?? (async () => []))();
    if (text.includes('idea_id')) return (opts.items ?? (async () => []))();
    if (text.includes('scout_ticks')) return (opts.ticks ?? (async () => []))();
    return Promise.resolve([]);
  };
  return fn as unknown as Sql;
}

afterEach(() => vi.restoreAllMocks());

describe('readScoutSnapshot', () => {
  it('aggregates rail counts + total and normalizes the newest tick (migration-208 shape)', async () => {
    const sql = fakeSql({
      rails: async () => [
        { rail: 'plan', count: 3 },
        { rail: 'gym', count: 1 },
      ],
      ticks: async () => [
        { tick_at: new Date('2026-06-09T08:00:00Z'), status: 'gated', gate: 'min-interval', detail: null },
      ],
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.totalRouted).toBe(4);
    expect(snap.railCounts).toEqual([
      { rail: 'plan', count: 3 },
      { rail: 'gym', count: 1 },
    ]);
    expect(snap.lastTick).toEqual({
      at: '2026-06-09T08:00:00.000Z',
      outcome: 'gated',
      detail: 'min-interval',
    });
  });

  it('maps the recent routed-idea rows into the UI shape (epoch-ms routed_at, null-safe optionals)', async () => {
    const sql = fakeSql({
      rails: async () => [{ rail: 'plan', count: 1 }],
      items: async () => [
        {
          idea_id: 'scout-idea-reframing-1-0',
          lens: 'reframing',
          rail: 'plan',
          routed_ref: 'plan:scout-something-2026-06-11',
          title: 'A reframed idea',
          routed_at: '1781210000000', // bigint arrives as a string
          outcome: null,
        },
        {
          idea_id: 'scout-idea-analogical-1-0',
          lens: 'analogical',
          rail: 'improvement',
          routed_ref: 'wi:EI-340',
          title: null,
          routed_at: null,
          outcome: 'won',
        },
      ],
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.recent).toEqual([
      {
        ideaId: 'scout-idea-reframing-1-0',
        lens: 'reframing',
        rail: 'plan',
        routedRef: 'plan:scout-something-2026-06-11',
        title: 'A reframed idea',
        routedAt: new Date(1781210000000).toISOString(),
        outcome: null,
      },
      {
        ideaId: 'scout-idea-analogical-1-0',
        lens: 'analogical',
        rail: 'improvement',
        routedRef: 'wi:EI-340',
        title: null,
        routedAt: null,
        outcome: 'won',
      },
    ]);
  });

  it('omits the tick half silently when scout_ticks does not exist yet (42P01)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({
      rails: async () => [],
      ticks: async () => {
        throw Object.assign(new Error('relation "harness_shared.scout_ticks" does not exist'), { code: '42P01' });
      },
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap).toEqual({ totalRouted: 0, railCounts: [], recent: [], lastTick: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns + omits the tick half on any other tick-read error (column drift etc.)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({
      rails: async () => [{ rail: 'wi', count: 2 }],
      ticks: async () => {
        throw Object.assign(new Error('column "tick_at" does not exist'), { code: '42703' });
      },
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.railCounts).toEqual([{ rail: 'wi', count: 2 }]); // rail half survives
    expect(snap.lastTick).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe('normalizeScoutTick', () => {
  it('returns null for a missing row', () => {
    expect(normalizeScoutTick(null)).toBeNull();
    expect(normalizeScoutTick(undefined)).toBeNull();
  });

  it('tolerates alternate column spellings (created_at / gate_outcome / reason)', () => {
    expect(
      normalizeScoutTick({ created_at: '2026-06-09T07:00:00.000Z', gate_outcome: 'ran', reason: 'idle gate open' }),
    ).toEqual({ at: '2026-06-09T07:00:00.000Z', outcome: 'ran', detail: 'idle gate open' });
  });

  it('falls back to the detail jsonb (reason/error) when no gate column is set', () => {
    expect(
      normalizeScoutTick({ tick_at: '2026-06-09T07:30:00.000Z', status: 'error', gate: null, detail: { error: 'cycle threw' } }),
    ).toEqual({ at: '2026-06-09T07:30:00.000Z', outcome: 'error', detail: 'cycle threw' });
  });

  it('yields nulls (not a crash) for a row with none of the expected columns', () => {
    expect(normalizeScoutTick({ something_else: 1 })).toEqual({ at: null, outcome: null, detail: null });
  });
});

describe('isUndefinedTable', () => {
  it('matches only SQLSTATE 42P01', () => {
    expect(isUndefinedTable(Object.assign(new Error('x'), { code: '42P01' }))).toBe(true);
    expect(isUndefinedTable(Object.assign(new Error('x'), { code: '42703' }))).toBe(false);
    expect(isUndefinedTable(new Error('x'))).toBe(false);
    expect(isUndefinedTable(null)).toBe(false);
  });
});
