/**
 * precision-read — the memory-precision trend read/write (relight P-033).
 * Pure SQL-shape tests over an injected fake `sql`: trend ordering, the fp@5
 * delta vs the previous run, the empty/degraded snapshot, and the INSERT shape.
 */
import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import {
  describePrecisionAttempt,
  readLatestPrecisionAttempt,
  readMemoryPrecision,
  recordMemoryPrecisionAttempt,
  recordMemoryPrecisionRun,
  type MemoryPrecisionMetrics,
} from './precision-read';

type Row = Record<string, unknown>;

/** A tagged-template `sql` stand-in: routes each query to `handler` by its text. */
function fakeSql(handler: (text: string, values: unknown[]) => Row[]): Sql {
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve(handler(strings.join(' ? '), values));
  return fn as unknown as Sql;
}

const benchRow = (ranAt: string, fp: number | null, r10: number | null): Row => ({
  ran_at: ranAt,
  backend: 'hybrid',
  fp_at_5: fp,
  r_at_10: r10,
  p_at_5: 0.9,
  mrr: 0.7,
  median_top_score: 0.6,
  floor_cosine: 0.45,
  floor_lex: 0.4,
  corpus_n: 114,
  gold_n: 150,
  latency_p50_ms: 12,
});

describe('readMemoryPrecision', () => {
  it('returns the newest run as latest and computes the fp@5 delta vs the previous run', async () => {
    const sql = fakeSql((text) => {
      if (text.includes('count(')) return [{ n: 5 }];
      // newest-first, as the SQL ORDER BY ran_at DESC returns it
      return [benchRow('2026-06-15T00:00:00Z', 0.17, 0.82), benchRow('2026-06-08T00:00:00Z', 0.2, 0.8)];
    });
    const snap = await readMemoryPrecision(sql, 'ws-1');
    expect(snap.latest?.ranAt).toBe('2026-06-15T00:00:00Z');
    expect(snap.latest?.fpAt5).toBe(0.17);
    expect(snap.trend).toHaveLength(2);
    expect(snap.runCount).toBe(5);
    // 0.17 - 0.20 = -0.03 (improving)
    expect(snap.fpAt5Delta).toBeCloseTo(-0.03, 5);
  });

  it('degrades to an empty snapshot when there are no runs', async () => {
    const sql = fakeSql((text) => (text.includes('count(') ? [{ n: 0 }] : []));
    const snap = await readMemoryPrecision(sql, 'ws-1');
    expect(snap.latest).toBeNull();
    expect(snap.trend).toEqual([]);
    expect(snap.fpAt5Delta).toBeNull();
    expect(snap.runCount).toBe(0);
  });

  it('leaves the delta null when the previous run has no fp@5', async () => {
    const sql = fakeSql((text) =>
      text.includes('count(') ? [{ n: 2 }] : [benchRow('b', 0.17, 0.82), benchRow('a', null, 0.8)],
    );
    const snap = await readMemoryPrecision(sql, 'ws-1');
    expect(snap.fpAt5Delta).toBeNull();
  });

  // P-008 (jev-decision-model-integration): turning the Jev switch On changes
  // what the bench measures; that step must not read as drift.
  it('computes the delta only against an earlier run of the SAME admission shape, and exposes the Jev gate', async () => {
    const gated = 'fusionMode:cosine-gated;jev:jev-1.13.0/instructions@0.3';
    const floorOnly = 'fusionMode:cosine-gated';
    const sql = fakeSql((text) =>
      text.includes('count(')
        ? [{ n: 3 }]
        : [
            { ...benchRow('c', 0.02, 0.81), notes: gated },
            { ...benchRow('b', 0.17, 0.82), notes: floorOnly },
            { ...benchRow('a', 0.05, 0.8), notes: gated },
          ],
    );
    const snap = await readMemoryPrecision(sql, 'ws-1');
    expect(snap.latest?.jevGate).toEqual({ model: 'jev-1.13.0', encoding: 'instructions', threshold: 0.3 });
    expect(snap.trend[1].jevGate).toBeNull();
    // 0.02 - 0.05 (the earlier GATED run), not 0.02 - 0.17 (the floor-only run between them)
    expect(snap.fpAt5Delta).toBeCloseTo(-0.03, 5);
  });

  it('has no delta when the latest shape has no earlier run (the switch was just flipped)', async () => {
    const sql = fakeSql((text) =>
      text.includes('count(')
        ? [{ n: 2 }]
        : [
            { ...benchRow('b', 0.02, 0.81), notes: 'fusionMode:cosine-gated;jev:jev-1.13.0/instructions@0.3' },
            { ...benchRow('a', 0.17, 0.82), notes: 'fusionMode:cosine-gated' },
          ],
    );
    expect((await readMemoryPrecision(sql, 'ws-1')).fpAt5Delta).toBeNull();
  });
});

describe('recordMemoryPrecisionRun', () => {
  it('inserts the metrics and returns the new row id', async () => {
    let capturedValues: unknown[] = [];
    const sql = fakeSql((text, values) => {
      capturedValues = values;
      expect(text).toContain('INSERT INTO harness_shared.memory_precision_bench');
      return [{ id: 99 }];
    });
    const m: MemoryPrecisionMetrics = {
      backend: 'hybrid',
      corpusVersion: 'v1',
      goldVersion: 'v1',
      corpusN: 114,
      goldN: 150,
      floorCosine: 0.45,
      floorLex: 0.4,
      fpAt5: 0.17,
      rAt10: 0.82,
      pAt5: 0.9,
      mrr: 0.7,
      medianTopScore: 0.6,
      latencyP50Ms: 12,
      byClass: { 'hard-negative': { fpAt5: 0.17 } },
      costUsd: null,
      notes: null,
    };
    const id = await recordMemoryPrecisionRun(sql, 'ws-7', m);
    expect(id).toBe(99);
    // workspace_id is the first bound value; the metrics follow.
    expect(capturedValues[0]).toBe('ws-7');
    expect(capturedValues).toContain(0.17);
  });
});

describe('memory-precision attempt ledger (WI-10004133)', () => {
  it('reads the newest attempt and attaches it to the snapshot', async () => {
    const sql = fakeSql((text) => {
      if (text.includes('memory_precision_bench_attempts')) {
        return [{ attempted_at: new Date('2026-09-30T07:00:00Z'), outcome: 'failed', stage: 'bench', error: 'worker timed out', row_id: null, jev_gate: true }];
      }
      if (text.includes('count(')) return [{ n: 1 }];
      return [benchRow('2026-09-23T00:00:00Z', 0.17, 0.82)];
    });
    const snap = await readMemoryPrecision(sql, 'ws-1');
    expect(snap.lastAttempt).toEqual({
      attemptedAt: '2026-09-30T07:00:00.000Z', outcome: 'failed', stage: 'bench', error: 'worker timed out', rowId: null, jevGate: true,
    });
    expect(describePrecisionAttempt(snap.lastAttempt)).toBe('last attempt 2026-09-30T07:00:00.000Z failed at bench: worker timed out');
  });

  it('degrades to null when the attempts table is missing or the row is malformed', async () => {
    const missing = fakeSql(() => {
      throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
    });
    expect(await readLatestPrecisionAttempt(missing, 'ws-1')).toBeNull();
    const malformed = fakeSql(() => [{ attempted_at: '2026-09-30T07:00:00Z', outcome: 'exploded' }]);
    expect(await readLatestPrecisionAttempt(malformed, 'ws-1')).toBeNull();
    expect(describePrecisionAttempt(null)).toBeNull();
  });

  it('writes one row per outcome, nulls the failed-only fields otherwise, and clips long errors', async () => {
    const writes: unknown[][] = [];
    const sql = fakeSql((_text, values) => {
      writes.push(values);
      return [{ id: writes.length }];
    });
    await recordMemoryPrecisionAttempt(sql, 'ws-7', { outcome: 'recorded', rowId: 9, jevGate: false });
    await recordMemoryPrecisionAttempt(sql, 'ws-7', { outcome: 'flag-off' });
    await recordMemoryPrecisionAttempt(sql, 'ws-7', { outcome: 'failed', stage: 'record', error: 'e'.repeat(5000), jevGate: true });
    expect(writes[0]).toEqual(['ws-7', 'recorded', null, null, 9, false]);
    expect(writes[1]).toEqual(['ws-7', 'flag-off', null, null, null, false]);
    expect(writes[2].slice(0, 3)).toEqual(['ws-7', 'failed', 'record']);
    expect(String(writes[2][3])).toHaveLength(2000);
    expect(writes[2].slice(4)).toEqual([null, true]);
  });
});
