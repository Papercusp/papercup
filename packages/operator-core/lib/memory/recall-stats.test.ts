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
