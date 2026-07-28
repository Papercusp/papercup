/**
 * recall-stats — recall-quality telemetry (EI-366 / consume-edges P-031,
 * migration 240). Pins: the fire-and-forget writer's row shape + its
 * never-throws contract, the fragment regression-canary counter, and the
 * health aggregate's mapping.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { MemoryEntry } from './backend';
import { countFragmentHits, readRecallHealth, recordRecallStats } from './recall-stats';

const entry = (id: string, score?: number, metadata?: Record<string, unknown>): MemoryEntry => ({
  id,
  text: id,
  scope: 's',
  ...(score !== undefined ? { score } : {}),
  ...(metadata !== undefined ? { metadata } : {}),
});

describe('countFragmentHits', () => {
  it('counts entries whose metadata carries entityType', () => {
    expect(countFragmentHits([
      entry('a', 0.5),
      entry('b', 0.4, { entityType: 'COMPOUND', linkedMemoryIds: ['x'] }),
      entry('c', 0.3, { kind: 'reference' }),
    ])).toBe(1);
  });
});

describe('recordRecallStats', () => {
  it('writes surface, counts, top score and the score list', async () => {
    const calls: unknown[][] = [];
    const sql = ((_s: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return Promise.resolve([]);
    }) as unknown as Sql;
    await recordRecallStats(sql, {
      surface: 'search',
      entries: [entry('a', 0.8), entry('b', 0.5), entry('c')],
    });
    expect(calls).toHaveLength(1);
    const [surface, hitCount, topScore, scoresJson, fragmentCount] = calls[0];
    expect(surface).toBe('search');
    expect(hitCount).toBe(3);
    expect(topScore).toBe(0.8);
    expect(JSON.parse(scoresJson as string)).toEqual([0.8, 0.5]);
    expect(fragmentCount).toBe(0);
  });

  it('records a zero-hit recall with a NULL top score', async () => {
    const calls: unknown[][] = [];
    const sql = ((_s: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return Promise.resolve([]);
    }) as unknown as Sql;
    await recordRecallStats(sql, { surface: 'injection', entries: [] });
    const [surface, hitCount, topScore] = calls[0];
    expect(surface).toBe('injection');
    expect(hitCount).toBe(0);
    expect(topScore).toBeNull();
  });

  it('NEVER throws — a failed insert is swallowed (telemetry is not load-bearing)', async () => {
    const sql = (() => Promise.reject(new Error('pg down'))) as unknown as Sql;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      recordRecallStats(sql, { surface: 'search', entries: [entry('a', 0.5)] }),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });

  // memory-delivery-unification-2026-07-12 P-005 (D-006): the surface column is
  // free-text, so each per-entry-point PORT records under its own label — the
  // union is documentation, not a DB constraint. Pins that a port label writes
  // through verbatim so per-port recall quality is measurable separately.
  it('records each injection PORT under its own surface label (P-005)', async () => {
    for (const port of ['initialize', 'compact', 'turn-start', 'brief', 'claim', 'create'] as const) {
      const calls: unknown[][] = [];
      const sql = ((_s: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(values);
        return Promise.resolve([]);
      }) as unknown as Sql;
      await recordRecallStats(sql, { surface: port, entries: [entry('a', 0.6)] });
      expect(calls[0]?.[0]).toBe(port);
    }
  });
});

/**
 * context-injection-audit-2026-07-28 P-026 (migration 703) — the RECURRENCE
 * GUARD for the defect class "telemetry that collapses distinguishable states
 * into one indistinguishable number".
 *
 * The push path fans out over three independently-budgeted pools and recorded
 * ONE hit_count. That is not a missing nice-to-have; it destroyed the only
 * information that could separate a healthy recall from a pool returning zero
 * on every single call. These tests fail if the collapse comes back.
 */
describe('recordRecallStats per-pool breakdown (P-026)', () => {
  const capture = (): { calls: unknown[][]; sql: Sql } => {
    const calls: unknown[][] = [];
    const sql = ((_s: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return Promise.resolve([]);
    }) as unknown as Sql;
    return { calls, sql };
  };
  // Positional, matching the INSERT column order.
  const POOLS = 5, WORKSPACE = 6, POT = 7;
  const poolsOf = (call: unknown[]) => JSON.parse(call[POOLS] as string);

  // THE bug, stated as a test. Both recalls return six memories, so both write
  // hit_count=6 — but one of them has a harness pool that contributed NOTHING.
  // Before P-026 those two rows were byte-identical, which is exactly why an
  // orphaned pool hid behind a surface reporting a 0.0% zero-hit rate.
  it('distinguishes two recalls with the SAME hit_count but different pool shapes', async () => {
    const healthy = capture();
    await recordRecallStats(healthy.sql, {
      surface: 'turn-start',
      pools: {
        user: { entries: [entry('u1', 0.9), entry('u2', 0.8), entry('u3', 0.7)], limit: 6, scopes: ['u:1'] },
        harness: { entries: [entry('h1', 0.6), entry('h2', 0.5), entry('h3', 0.4)], limit: 3, scopes: ['harness:papercusp'] },
        hive: { entries: [], limit: 3, scopes: ['hive:papercusp'] },
      },
    });

    const orphaned = capture();
    await recordRecallStats(orphaned.sql, {
      surface: 'turn-start',
      pools: {
        user: { entries: [1, 2, 3, 4, 5, 6].map((n) => entry(`u${n}`, 0.9)), limit: 6, scopes: ['u:1'] },
        // The pool exists, is queried, and returns nothing — every call.
        harness: { entries: [], limit: 3, scopes: ['harness:papercup'] },
        hive: { entries: [], limit: 3, scopes: ['hive:papercusp'] },
      },
    });

    // The flat columns are IDENTICAL — that is the point.
    expect(healthy.calls[0]![1]).toBe(6);
    expect(orphaned.calls[0]![1]).toBe(6);

    // The pool breakdown is not.
    expect(poolsOf(healthy.calls[0]!).harness).toMatchObject({ hits: 3, limit: 3 });
    expect(poolsOf(orphaned.calls[0]!).harness).toMatchObject({ hits: 0, top: null, limit: 3 });
    expect(poolsOf(healthy.calls[0]!)).not.toEqual(poolsOf(orphaned.calls[0]!));
  });

  it('records each pool OWN top score — a strong sibling cannot mask a weak pool', async () => {
    const { calls, sql } = capture();
    await recordRecallStats(sql, {
      surface: 'turn-start',
      pools: {
        user: { entries: [entry('u1', 0.95)], limit: 6, scopes: ['u:1'] },
        harness: { entries: [entry('h1', 0.02)], limit: 3, scopes: ['harness:papercusp'] },
        hive: { entries: [], limit: 3, scopes: [] },
      },
    });
    // Flat top_score is the max across pools and says nothing about the harness pool.
    expect(calls[0]![2]).toBe(0.95);
    const pools = poolsOf(calls[0]!);
    expect(pools.user.top).toBe(0.95);
    expect(pools.harness.top).toBe(0.02);
    expect(pools.hive.top).toBeNull();
  });

  // The budget is recorded, not inferred. P-032/P-033 both retune these
  // constants; a saturation measurement that compares a stored hit count
  // against TODAY's constant silently misreads every older row.
  it('stores the per-pool budget and scopes IN EFFECT for the call', async () => {
    const { calls, sql } = capture();
    await recordRecallStats(sql, {
      surface: 'turn-start',
      pools: {
        harness: { entries: [entry('h1', 0.3)], limit: 9, scopes: ['harness:a', 'harness:b'] },
      },
    });
    expect(poolsOf(calls[0]!).harness).toEqual({
      hits: 1, top: 0.3, limit: 9, scopes: ['harness:a', 'harness:b'],
    });
  });

  it('DERIVES the flat totals from the pools — hit_count can never drift from the breakdown', async () => {
    const { calls, sql } = capture();
    await recordRecallStats(sql, {
      surface: 'turn-start',
      pools: {
        user: { entries: [entry('u1', 0.9), entry('u2')], limit: 6, scopes: ['u:1'] },
        harness: { entries: [entry('h1', 0.4)], limit: 3, scopes: ['harness:x'] },
        hive: { entries: [], limit: 3, scopes: [] },
      },
    });
    const [, hitCount, topScore, scoresJson] = calls[0]!;
    const pools = poolsOf(calls[0]!);
    const summed = Object.values(pools).reduce((n, p) => n + (p as { hits: number }).hits, 0);
    expect(hitCount).toBe(3);
    expect(summed).toBe(hitCount);
    expect(topScore).toBe(0.9);
    // An entry with no score contributes to hits but not to the score list.
    expect(JSON.parse(scoresJson as string)).toEqual([0.9, 0.4]);
  });

  it('leaves pools NULL on a flat (pull-path) recall — single-pool stays distinguishable', async () => {
    const { calls, sql } = capture();
    await recordRecallStats(sql, { surface: 'search', entries: [entry('a', 0.5)] });
    expect(calls[0]![POOLS]).toBeNull();
  });

  // Migration 290 added these columns; nothing wrote them for 56,841 rows.
  it('writes workspace_id and pot_slug (dead since migration 290 until P-026)', async () => {
    const { calls, sql } = capture();
    await recordRecallStats(sql, {
      surface: 'turn-start',
      workspaceId: 'ws-1',
      potSlug: 'papercusp',
      pools: { user: { entries: [], limit: 6, scopes: ['u:1'] } },
    });
    expect(calls[0]![WORKSPACE]).toBe('ws-1');
    expect(calls[0]![POT]).toBe('papercusp');
  });

  it('still NEVER throws when a per-pool write fails', async () => {
    const sql = (() => Promise.reject(new Error('pg down'))) as unknown as Sql;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      recordRecallStats(sql, {
        surface: 'turn-start',
        pools: { user: { entries: [entry('a', 0.5)], limit: 6, scopes: ['u:1'] } },
      }),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('readRecallHealthByPool (P-026)', () => {
  const sqlReturning = (rows: Array<Record<string, unknown>>): Sql =>
    ((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve(rows)) as unknown as Sql;

  it('surfaces a pool at a 100% zero-hit rate beside a healthy sibling', async () => {
    const { readRecallHealthByPool } = await import('./recall-stats');
    const rows = await readRecallHealthByPool(sqlReturning([
      { surface: 'turn-start', pool: 'user', recalls: 100, zero_hits: 0, saturated: 97,
        hits_p50: '6', top_p50: '0.03', scope_keys: ['u:1'] },
      // The gate-2 signature: never returns anything, and the scope set moved.
      { surface: 'turn-start', pool: 'harness', recalls: 100, zero_hits: 100, saturated: 0,
        hits_p50: '0', top_p50: null, scope_keys: ['harness:papercup', 'harness:papercusp'] },
    ]));
    expect(rows[0]).toMatchObject({ pool: 'user', zeroHitRate: 0, saturationRate: 0.97, topScoreP50: 0.03 });
    expect(rows[1]).toMatchObject({ pool: 'harness', zeroHitRate: 1, saturationRate: 0, topScoreP50: null });
    expect(rows[1]!.scopes).toEqual(['harness:papercup', 'harness:papercusp']);
  });

  it('an empty window yields an empty list (degrade-to-empty, never a throw)', async () => {
    const { readRecallHealthByPool } = await import('./recall-stats');
    expect(await readRecallHealthByPool(sqlReturning([]))).toEqual([]);
  });
});

describe('readRecallHealthBySurface (orient-recall-quality P-006)', () => {
  const sqlReturning = (rows: Array<Record<string, unknown>>): Sql =>
    ((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve(rows)) as unknown as Sql;

  it('maps each surface row independently (a single-surface regression stays visible)', async () => {
    const { readRecallHealthBySurface } = await import('./recall-stats');
    const rows = await readRecallHealthBySurface(sqlReturning([
      { surface: 'search', recalls: 100, zero_hits: 10, p50: '0.6', p90: '0.8', fragment_hits: 0 },
      // orient regressing alone: zero-hit rate 0.9 while search sits at 0.1.
      { surface: 'orient', recalls: 20, zero_hits: 18, p50: null, p90: null, fragment_hits: 0 },
    ]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ surface: 'search', recalls7d: 100, zeroHitRate7d: 0.1, topScoreP50: 0.6 });
    expect(rows[1]).toMatchObject({ surface: 'orient', recalls7d: 20, zeroHit7d: 18, zeroHitRate7d: 0.9, topScoreP50: null });
  });

  it('an empty window yields an empty list (degrade-to-empty, never a throw)', async () => {
    const { readRecallHealthBySurface } = await import('./recall-stats');
    expect(await readRecallHealthBySurface(sqlReturning([]))).toEqual([]);
  });
});

describe('readRecallHealth', () => {
  const sqlReturning = (rows: Array<Record<string, unknown>>): Sql =>
    ((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve(rows)) as unknown as Sql;

  it('maps the trailing-window aggregate', async () => {
    const health = await readRecallHealth(sqlReturning([
      { recalls: 20, zero_hits: 5, p50: '0.51', p90: '0.7', fragment_hits: 2 },
    ]));
    expect(health).toEqual({
      recalls7d: 20,
      zeroHit7d: 5,
      zeroHitRate7d: 0.25,
      topScoreP50: 0.51,
      topScoreP90: 0.7,
      fragmentHits7d: 2,
    });
  });

  it('an empty window yields zero rate and null percentiles', async () => {
    const health = await readRecallHealth(sqlReturning([
      { recalls: 0, zero_hits: 0, p50: null, p90: null, fragment_hits: 0 },
    ]));
    expect(health).toEqual({
      recalls7d: 0,
      zeroHit7d: 0,
      zeroHitRate7d: 0,
      topScoreP50: null,
      topScoreP90: null,
      fragmentHits7d: 0,
    });
  });
});
