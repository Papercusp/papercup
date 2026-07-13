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

function fakeSql(opts: {
  rails?: Handler;
  items?: Handler;
  ticks?: Handler;
  weights?: Handler;
  /** The P-002 per-cycle lens join (GROUP BY cycle_id over scout_routed_ideas). */
  lensJoin?: Handler;
}): Sql {
  const fn = (strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const text = strings.join(' ');
    // Both ledger reads hit scout_routed_ideas — the aggregate groups by rail,
    // the per-item read selects idea_id. The lens-weight half (C-1c) reads
    // scout_lens_weights through routed-ledger's readScoutLensWeights with
    // THIS injected sql. The P-002 economics leg adds the per-cycle lens join
    // (GROUP BY cycle_id). NOTE: readScoutSnapshot also calls sql(cycleIds) as
    // the postgres list helper — that lands here with a plain string[] whose
    // join matches nothing, so it falls through to the empty default (a value
    // fragment, never awaited).
    if (text.includes('GROUP BY rail')) return (opts.rails ?? (async () => []))();
    if (text.includes('GROUP BY cycle_id')) return (opts.lensJoin ?? (async () => []))();
    if (text.includes('scout_lens_weights')) return (opts.weights ?? (async () => []))();
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

  it('maps the recent routed-idea rows into the UI shape (epoch-ms routed_at, null-safe optionals, grade fields)', async () => {
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
          // ungraded row: grade columns NULL (or absent pre-migration-234)
          human_grade: null,
          human_feedback: null,
          graded_by: null,
        },
        {
          idea_id: 'scout-idea-analogical-1-0',
          lens: 'analogical',
          rail: 'improvement',
          routed_ref: 'wi:EI-340',
          title: null,
          routed_at: null,
          outcome: 'won',
          human_grade: 4,
          human_feedback: 'sharp framing, do more of these',
          graded_by: 'Queen',
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
        humanGrade: null,
        humanFeedback: null,
        gradedBy: null,
      },
      {
        ideaId: 'scout-idea-analogical-1-0',
        lens: 'analogical',
        rail: 'improvement',
        routedRef: 'wi:EI-340',
        title: null,
        routedAt: null,
        outcome: 'won',
        humanGrade: 4,
        humanFeedback: 'sharp framing, do more of these',
        gradedBy: 'Queen',
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
    expect(snap).toEqual({ totalRouted: 0, railCounts: [], recent: [], lastTick: null, ticks: [], lensWeights: null });
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

  it('surfaces the persisted lens weights (C-1c), filtered to known lenses', async () => {
    const sql = fakeSql({
      weights: async () => [
        { lens: 'analogical', weight: '0.4' }, // numeric arrives as a string
        { lens: 'reframing', weight: 0.35 },
        { lens: 'not-a-lens', weight: 0.25 }, // unknown lens ids are ignored
      ],
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.lensWeights).toEqual({ analogical: 0.4, reframing: 0.35 });
  });

  it('lensWeights is null when no weight rows are recorded yet', async () => {
    const snap = await readScoutSnapshot(fakeSql({}), 'ws-1');
    expect(snap.lensWeights).toBeNull();
  });

  it('lensWeights degrades to null (warn, never a crash) when the weight read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({
      rails: async () => [{ rail: 'plan', count: 1 }],
      weights: async () => {
        throw Object.assign(new Error('permission denied'), { code: '42501' });
      },
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.lensWeights).toBeNull();
    expect(snap.totalRouted).toBe(1); // the routed half survives
    expect(warn).toHaveBeenCalled();
  });
});

describe('tick economics (learning-tab-alignment P-002)', () => {
  it('maps the newest ticks into economics rows — stop from detail.stop / gate / error, spend numeric-string safe, funnel counts', async () => {
    const sql = fakeSql({
      ticks: async () => [
        {
          tick_at: new Date('2026-07-13T04:00:00Z'),
          status: 'ran',
          gate: null,
          ideas_generated: 8,
          ideas_routed: 3,
          ideas_deduped: 2,
          budget_used_usd: '1.673', // numeric arrives as a string
          detail: { stop: 'completed', cycleId: 'scout-100' },
        },
        {
          tick_at: new Date('2026-07-13T03:30:00Z'),
          status: 'ran',
          gate: null,
          ideas_generated: 32,
          ideas_routed: 0,
          ideas_deduped: 0,
          budget_used_usd: 3.603,
          detail: { stop: 'budget-exhausted', cycleId: 'scout-99' },
        },
        {
          tick_at: new Date('2026-07-13T03:00:00Z'),
          status: 'gated',
          gate: 'min-interval',
          ideas_generated: 0,
          ideas_routed: 0,
          ideas_deduped: 0,
          budget_used_usd: null,
          detail: null,
        },
        {
          tick_at: new Date('2026-07-13T02:30:00Z'),
          status: 'error',
          gate: null,
          ideas_generated: 0,
          ideas_routed: 0,
          ideas_deduped: 0,
          budget_used_usd: null,
          detail: { error: 'cycle threw: rate-limit pause exceeds maxWait' },
        },
      ],
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.ticks).toEqual([
      {
        at: '2026-07-13T04:00:00.000Z',
        status: 'ran',
        stop: 'completed',
        generated: 8,
        routed: 3,
        deduped: 2,
        spendUsd: 1.673,
        cycleId: 'scout-100',
        lenses: {},
      },
      {
        at: '2026-07-13T03:30:00.000Z',
        status: 'ran',
        stop: 'budget-exhausted',
        generated: 32,
        routed: 0,
        deduped: 0,
        spendUsd: 3.603,
        cycleId: 'scout-99',
        lenses: {},
      },
      {
        at: '2026-07-13T03:00:00.000Z',
        status: 'gated',
        stop: 'min-interval',
        generated: 0,
        routed: 0,
        deduped: 0,
        spendUsd: null,
        cycleId: null,
        lenses: {},
      },
      {
        at: '2026-07-13T02:30:00.000Z',
        status: 'error',
        stop: 'cycle threw: rate-limit pause exceeds maxWait',
        generated: 0,
        routed: 0,
        deduped: 0,
        spendUsd: null,
        cycleId: null,
        lenses: {},
      },
    ]);
    // lastTick stays derived from row 0 (back-compat with the pre-P-002 shape).
    expect(snap.lastTick).toEqual({ at: '2026-07-13T04:00:00.000Z', outcome: 'ran', detail: 'completed' });
  });

  it('joins per-cycle lens counts onto the ticks that have a cycleId', async () => {
    const sql = fakeSql({
      ticks: async () => [
        {
          tick_at: new Date('2026-07-13T04:00:00Z'),
          status: 'ran',
          ideas_generated: 8,
          ideas_routed: 3,
          ideas_deduped: 2,
          budget_used_usd: 1.5,
          detail: { stop: 'completed', cycleId: 'scout-100' },
        },
        {
          tick_at: new Date('2026-07-13T03:00:00Z'),
          status: 'gated',
          gate: 'no-trigger',
          detail: null,
        },
      ],
      lensJoin: async () => [
        { cycle_id: 'scout-100', lens: 'first-principles', count: 2 },
        { cycle_id: 'scout-100', lens: 'analogical', count: 1 },
        { cycle_id: 'scout-999', lens: 'reframing', count: 4 }, // not one of our ticks — ignored
      ],
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.ticks[0].lenses).toEqual({ 'first-principles': 2, analogical: 1 });
    expect(snap.ticks[1].lenses).toEqual({});
  });

  it('economics degrade to [] with lastTick when the tick read fails (never fails the routed half)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({
      rails: async () => [{ rail: 'plan', count: 2 }],
      ticks: async () => {
        throw Object.assign(new Error('column drift'), { code: '42703' });
      },
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.ticks).toEqual([]);
    expect(snap.totalRouted).toBe(2);
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
