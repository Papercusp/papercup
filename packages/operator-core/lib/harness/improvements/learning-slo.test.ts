/**
 * learning-slo.test.ts — FB-21 audit-as-sensors (self-learning-frontier
 * P-047): the five learning-system SLO collectors. Pure mappers run without
 * PG; the IO wrappers run against the injectable deps seam — including the
 * two pins the brief demands: the D-001 dark gate (flag OFF ⇒ note + zero
 * signals + zero IO) and MTTSH dormant-tolerance (FB-20 absent ⇒ note,
 * never an error).
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { LearningLoopRegistration } from '../../learning-governor/core';
import {
  LEARNING_SLO_DARK_NOTE,
  LEARNING_SLO_DEFAULTS,
  collectMemoryZeroHitSignals,
  flowSignalsFromAggregate,
  governorStarvationSignals,
  medianOf,
  memoryZeroHitSignalsFromAggregate,
  mttshRegressionCollector,
  mttshSignalsFromWindows,
  normalizedTriageEntropy,
  recallPoolSignalsFromHealth,
  recallScaleSignalsFromContradictions,
  trimStatisticalOutliers,
  triageEntropyCollector,
  triageEntropySignalsFromRows,
} from './learning-slo';
import type { RecallPoolHealth, RecallSurfaceHealth } from '../../memory/recall-stats';

const decisions = (counts: Record<string, number>): { decision: string }[] =>
  Object.entries(counts).flatMap(([decision, n]) => Array.from({ length: n }, () => ({ decision })));

const loop = (over: Partial<LearningLoopRegistration> = {}): LearningLoopRegistration => ({
  workspaceId: 'ws',
  loopId: 'gym-autoloop',
  potSlug: null,
  displayName: 'gym-autoloop',
  budgetKind: 'lifetime',
  budgetUsd: 10,
  spentUsd: 9.8,
  priority: 50,
  enabled: true,
  enforcement: 'governor',
  meta: null,
  registeredAt: 0,
  updatedAt: 0,
  ...over,
});

describe('normalizedTriageEntropy', () => {
  it('is 0 for a single-lane distribution and 1 for uniform over the full space', () => {
    expect(normalizedTriageEntropy({ gate: 100 }).entropy).toBe(0);
    const uniform = normalizedTriageEntropy({ place: 25, gate: 25, gym: 25, reject: 25 });
    expect(uniform.entropy).toBeCloseTo(1, 10);
    expect(uniform.n).toBe(100);
  });

  it('is low-but-nonzero for a near-degenerate mix', () => {
    const { entropy } = normalizedTriageEntropy({ gate: 95, place: 5 });
    expect(entropy).toBeGreaterThan(0);
    expect(entropy).toBeLessThan(LEARNING_SLO_DEFAULTS.triageEntropyMinNormalized);
  });
});

describe('triageEntropySignalsFromRows (the EI-364 degeneracy class)', () => {
  it('fires kind=bug on the EI-364 shape: 100/100 items routed to one lane', () => {
    const out = triageEntropySignalsFromRows(decisions({ gate: 100 }));
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('triage-entropy');
    expect(out[0].key).toBe('triage-decision-distribution');
    // FB-18 kind-fidelity pin: a clear-correct-state, code-caused breach is
    // bug-shaped → AUTO lane.
    expect(out[0].kind).toBe('bug');
    expect(out[0].severity).toBe('major');
    expect(out[0].body).toContain('gate: 100');
    expect(out[0].latestAt).toBeUndefined(); // live-state: post-resolve re-file is always legitimate
  });

  it('stays quiet on a healthy mixed distribution', () => {
    expect(triageEntropySignalsFromRows(decisions({ place: 30, gate: 30, gym: 20, reject: 20 }))).toEqual([]);
  });

  it('stays quiet under the minimum sample (no SLO on thin data)', () => {
    expect(triageEntropySignalsFromRows(decisions({ gate: 19 }))).toEqual([]);
  });

  it('honors tunable overrides', () => {
    expect(triageEntropySignalsFromRows(decisions({ gate: 19 }), { triageEntropyMinSample: 10 })).toHaveLength(1);
    expect(
      triageEntropySignalsFromRows(decisions({ gate: 100 }), { triageEntropyMinNormalized: 0 }),
    ).toEqual([]); // SLO of 0 = never degenerate
  });
});

describe('flowSignalsFromAggregate (capture-vs-consume imbalance)', () => {
  it('fires kind=change when inflow outruns the consume edge at the SLO ratio', () => {
    const out = flowSignalsFromAggregate({ inflow: 30, outflow: 5, backlog: 120 });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('capture-consume-imbalance');
    // FB-18 kind-fidelity pin: a capacity/policy judgment is change-shaped → gate lane.
    expect(out[0].kind).toBe('change');
    expect(out[0].body).toContain('30 improvement(s) captured vs 5 consumed');
    expect(out[0].body).toContain('120');
  });

  it('a zero-consumption window cannot divide away the breach', () => {
    expect(flowSignalsFromAggregate({ inflow: 12, outflow: 0, backlog: 50 })).toHaveLength(1);
  });

  it('stays quiet on balanced flow and under the inflow volume bar', () => {
    expect(flowSignalsFromAggregate({ inflow: 30, outflow: 28, backlog: 40 })).toEqual([]);
    expect(flowSignalsFromAggregate({ inflow: 9, outflow: 0, backlog: 40 })).toEqual([]);
  });
});

describe('mttshSignalsFromWindows (MTTSH regression)', () => {
  const ms = (...secs: number[]): number[] => secs.map((s) => s * 1000);

  it('fires kind=change when the recent median regresses past baseline × factor', () => {
    const out = mttshSignalsFromWindows({
      recentMs: ms(150, 160, 155, 170, 145),
      baselineMs: ms(100, 95, 105, 100, 98, 102),
    });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('mttsh-regression');
    expect(out[0].kind).toBe('change');
    expect(out[0].body).toContain('155s');
    expect(out[0].body).toContain('100s');
  });

  it('stays quiet on a stable pipeline and on thin windows', () => {
    expect(
      mttshSignalsFromWindows({ recentMs: ms(110, 105, 100, 115, 108), baselineMs: ms(100, 95, 105, 100, 98) }),
    ).toEqual([]);
    expect(
      mttshSignalsFromWindows({ recentMs: ms(300, 310), baselineMs: ms(100, 95, 105, 100, 98) }),
    ).toEqual([]); // recent window under minSamples
    expect(mttshSignalsFromWindows({ recentMs: ms(300, 310, 305, 320, 315), baselineMs: ms(100) })).toEqual([]);
  });

  it('medianOf handles odd and even lengths', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 2, 3])).toBe(2.5);
  });

  it('EI-8387: a handful of incident-correlated extreme-outlier drills does NOT manufacture a regression', () => {
    // The ACTUAL production shape that triggered EI-8387's false-positive
    // (harness_shared.red_queen_drills, 7d window, 2026-07-07): a normal
    // population of sub-2-minute drills PLUS 6 multi-MINUTE outliers all
    // landing inside one confirmed shared infra-incident window
    // (2026-06-30 ~18:20-18:35 — every drill class spiked in lockstep).
    // Without trimming this raw-median'd to "36s vs a 15s baseline" (2.4x,
    // past the 1.5x SLO) even though the collector queries themselves ran in
    // ~30ms when investigated live — a detector false-positive, not a real
    // engine regression.
    const recentMs = [
      1064, 1247, 1401, 1460, 1594, 1783, 3018, 4634, 4925, 5383, 8960, 12877,
      35646, 36094, 41937, 51786, 76667, 88037, 128578, 167930,
      793395, 793682, 939375, 953104, 1118956, 1459839, // the incident cluster
    ];
    const baselineMs = ms(15, 14, 16, 13, 15, 17, 14, 16); // the prior clean 15s-median window
    expect(mttshSignalsFromWindows({ recentMs, baselineMs })).toEqual([]);
  });

  it('trimStatisticalOutliers: Tukey-fences the top tail, never empties the set, no-ops under 4 samples', () => {
    expect(trimStatisticalOutliers([1, 2, 3])).toEqual([1, 2, 3]); // too few — no-op
    const withOutlier = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100_000];
    const trimmed = trimStatisticalOutliers(withOutlier);
    expect(trimmed).not.toContain(100_000);
    expect(trimmed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // An all-outlier-shaped input never degrades to an empty array.
    expect(trimStatisticalOutliers([1, 1, 1, 1]).length).toBeGreaterThan(0);
  });
});

describe('governorStarvationSignals (D-004 starvation)', () => {
  it('fires kind=change per starved loop: enabled + budgeted + spent to the floor', () => {
    const out = governorStarvationSignals([loop()]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('governor-starvation');
    expect(out[0].key).toBe('starved:gym-autoloop');
    expect(out[0].kind).toBe('change'); // budgets are the owner's dial — never the auto lane
    expect(out[0].body).toContain('refuses every unattended run');
  });

  it('deliberately ignores the dark-ship shapes: unbudgeted, disabled, per-cycle, healthy', () => {
    expect(governorStarvationSignals([loop({ budgetUsd: null })])).toEqual([]); // P-001 watch list, not a breach
    expect(governorStarvationSignals([loop({ enabled: false })])).toEqual([]);
    expect(governorStarvationSignals([loop({ budgetKind: 'per-cycle' })])).toEqual([]);
    expect(governorStarvationSignals([loop({ spentUsd: 2 })])).toEqual([]);
  });

  it('honors the floor tunable', () => {
    expect(governorStarvationSignals([loop({ spentUsd: 8 })], { governorStarvationFloorUsd: 2.5 })).toHaveLength(1);
  });
});

describe('memoryZeroHitSignalsFromAggregate (B-10 telemetry spike)', () => {
  it('fires kind=bug on a spike vs the trailing baseline', () => {
    const out = memoryZeroHitSignalsFromAggregate({
      recentRecalls: 30, recentZero: 18, baselineRecalls: 200, baselineZero: 20,
    });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('memory-zero-hit');
    expect(out[0].kind).toBe('bug');
    expect(out[0].body).toContain('60%');
    expect(out[0].body).toContain('10% baseline');
  });

  it('fires on the absolute SLO when no usable baseline exists (fresh telemetry)', () => {
    const out = memoryZeroHitSignalsFromAggregate({
      recentRecalls: 25, recentZero: 13, baselineRecalls: 3, baselineZero: 0,
    });
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain('no usable baseline');
  });

  it('stays quiet on healthy rates, thin volume, and an already-high baseline (no spike)', () => {
    expect(
      memoryZeroHitSignalsFromAggregate({ recentRecalls: 30, recentZero: 3, baselineRecalls: 200, baselineZero: 20 }),
    ).toEqual([]); // 10% — healthy
    expect(
      memoryZeroHitSignalsFromAggregate({ recentRecalls: 10, recentZero: 9, baselineRecalls: 200, baselineZero: 20 }),
    ).toEqual([]); // under minRecalls
    expect(
      memoryZeroHitSignalsFromAggregate({ recentRecalls: 30, recentZero: 14, baselineRecalls: 200, baselineZero: 80 }),
    ).toEqual([]); // 47% recent vs 40% baseline — over the absolute rate but NOT a spike
  });

  // EI-7774: a rate spike alone can't tell a healthy cold-query zero burst
  // apart from real EI-366 index degradation — only the latter also
  // collapses the top-score P50 of the recalls that DID hit.
  it('EI-7774: stays quiet on a rate spike whose non-zero recalls score normally (healthy cold-query burst)', () => {
    expect(
      memoryZeroHitSignalsFromAggregate({
        recentRecalls: 30, recentZero: 18, baselineRecalls: 200, baselineZero: 20,
        recentTopScoreP50: 0.42, baselineTopScoreP50: 0.4, // stable / even slightly better
      }),
    ).toEqual([]);
  });

  it('EI-7774: still fires when the rate spikes AND the non-zero top-score P50 also collapses', () => {
    const out = memoryZeroHitSignalsFromAggregate({
      recentRecalls: 30, recentZero: 18, baselineRecalls: 200, baselineZero: 20,
      recentTopScoreP50: 0.1, baselineTopScoreP50: 0.4, // collapsed to 25% of baseline
    });
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain('top-score P50 also collapsed');
    expect(out[0].body).toContain('0.100');
    expect(out[0].body).toContain('0.400');
  });

  it('EI-7774: falls back to rate-only firing when P50 data is missing/null (backward compatible)', () => {
    const out = memoryZeroHitSignalsFromAggregate({
      recentRecalls: 30, recentZero: 18, baselineRecalls: 200, baselineZero: 20,
      recentTopScoreP50: null, baselineTopScoreP50: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].body).not.toContain('top-score P50');
  });
});

/**
 * P-036 regression guard. The EI-7774 top-score check exists to SUPPRESS false
 * alarms — it refuses to fire when the recalls that hit still score normally.
 * But it compared two medians taken over a MIXED-scale column: rrf tops out at
 * 0.033 while cosine starts at 0.50. So a pure WORKLOAD-MIX shift between the
 * windows (more push-path recalls recently, say) collapses the blended median
 * ~25x with retrieval completely unchanged — converting the suppressor into a
 * false-alarm ENABLER, and firing exactly the spurious critical D-001 had to
 * retract. These pin the same-scale pairing that fixes it.
 */
describe('collectMemoryZeroHitSignals — the two P50s must be SAME-SCALE (P-036)', () => {
  const sqlReturning = (rows: Array<Record<string, unknown>>): Sql =>
    ((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve(rows)) as unknown as Sql;

  it('stays quiet when only the workload MIX shifted, not retrieval quality', async () => {
    const out = await collectMemoryZeroHitSignals(sqlReturning([{
      // Rate conditions all satisfied: 60% recent vs a 10% baseline, a 6x spike.
      recent_recalls: 100, recent_zero: 60, base_recalls: 500, base_zero: 50,
      per_scale: [
        // The MIX inverted — cosine carried the baseline, rrf carries the
        // recent window — while EACH scale's own median held steady.
        { scale: 'cosine', recent_n: 5, recent_p50: 0.83, base_n: 400, base_p50: 0.85 },
        { scale: 'rrf', recent_n: 90, recent_p50: 0.032, base_n: 80, base_p50: 0.0325 },
      ],
    }]));
    // Blending would compare 0.032 against 0.85 — a 26x "collapse" out of thin
    // air. Pairing on rrf compares 0.032 vs 0.0325: no collapse, stay quiet.
    expect(out).toEqual([]);
  });

  it('still fires when the SAME scale genuinely collapses, and names it', async () => {
    const out = await collectMemoryZeroHitSignals(sqlReturning([{
      recent_recalls: 100, recent_zero: 60, base_recalls: 500, base_zero: 50,
      per_scale: [{ scale: 'rrf', recent_n: 90, recent_p50: 0.012, base_n: 80, base_p50: 0.032 }],
    }]));
    expect(out).toHaveLength(1);
    // The scale is reported so a human reading the finding can tell which
    // population degraded — a bare score is the D-001 ambiguity again.
    expect(out[0]!.body).toContain('[rrf scale]');
  });

  it('falls back to the rate-only gate when no scale has data in BOTH windows', async () => {
    const out = await collectMemoryZeroHitSignals(sqlReturning([{
      recent_recalls: 100, recent_zero: 60, base_recalls: 500, base_zero: 50,
      // Present in the recent window only — yields no comparison at all rather
      // than a cross-scale one.
      per_scale: [{ scale: 'rrf', recent_n: 90, recent_p50: 0.03, base_n: 0, base_p50: null }],
    }]));
    expect(out).toHaveLength(1);
    expect(out[0]!.body).not.toContain('scale]');
  });

  it('ignores unknown-scale rows entirely rather than pairing them', async () => {
    const out = await collectMemoryZeroHitSignals(sqlReturning([{
      recent_recalls: 100, recent_zero: 60, base_recalls: 500, base_zero: 50,
      // An 'unknown' bucket is INDETERMINATE — pairing it would be the mixing
      // bug wearing a label. The SQL excludes it; nothing here may resurrect it.
      per_scale: [{ scale: 'unknown', recent_n: 90, recent_p50: 0.01, base_n: 400, base_p50: 0.85 }],
    }]));
    expect(out).toHaveLength(1);
    expect(out[0]!.body).not.toContain('scale]');
  });
});

describe('the D-001 dark gate (flag OFF)', () => {
  const sqlMustNotRun = (() => {
    throw new Error('sql must not be touched while dark');
  }) as unknown as () => Sql;

  it('every collector reports the dark note, emits nothing, and never touches PG', async () => {
    const deps = { isArmed: async () => false, sql: sqlMustNotRun };
    const res = await triageEntropyCollector('ws', {}, deps);
    expect(res.signals).toEqual([]);
    expect(res.note).toBe(LEARNING_SLO_DARK_NOTE);
    const res2 = await mttshRegressionCollector({}, deps);
    expect(res2.signals).toEqual([]);
    expect(res2.note).toBe(LEARNING_SLO_DARK_NOTE);
  });

  it('a broken flag read keeps the sensors dark (never fails toward filing)', async () => {
    const res = await triageEntropyCollector('ws', {}, {
      isArmed: async () => { throw new Error('flag store down'); },
      sql: sqlMustNotRun,
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toBe(LEARNING_SLO_DARK_NOTE);
  });
});

describe('MTTSH dormant tolerance (the FB-20 seam)', () => {
  const fakeSql = (rows: { onRegclass: unknown[]; onSelect?: () => unknown[] }): (() => Sql) => {
    const fn = (strings: TemplateStringsArray, ..._args: unknown[]): Promise<unknown[]> => {
      const q = strings.join('?');
      if (q.includes('to_regclass')) return Promise.resolve(rows.onRegclass);
      if (!rows.onSelect) return Promise.resolve([]);
      try {
        return Promise.resolve(rows.onSelect());
      } catch (e) {
        return Promise.reject(e);
      }
    };
    return () => fn as unknown as Sql;
  };

  it('an absent red-queen store is a per-tick note, never an error', async () => {
    const res = await mttshRegressionCollector({}, {
      isArmed: async () => true,
      sql: fakeSql({ onRegclass: [{ t: null }] }),
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toContain('dormant: red-queen drill store not landed');
  });

  it('an unexpected store shape degrades to a visible seam note, never a failing collector', async () => {
    const res = await mttshRegressionCollector({}, {
      isArmed: async () => true,
      sql: fakeSql({
        onRegclass: [{ t: 'red_queen_drills' }],
        onSelect: () => { throw new Error('column "mttsh_ms" does not exist'); },
      }),
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toContain('update readMttshSamples');
    expect(res.note).toContain('mttsh_ms');
  });

  it('a landed-but-quiet store (no measured drills) emits nothing without a note', async () => {
    const res = await mttshRegressionCollector({}, {
      isArmed: async () => true,
      sql: fakeSql({ onRegclass: [{ t: 'red_queen_drills' }], onSelect: () => [] }),
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toBeUndefined();
  });
});

/*
 * recall-pool (context-injection-audit-2026-07-28 P-013 / D-023 / D-024).
 *
 * The cases below are the traps this detector had to be built around, not
 * coverage for its arithmetic. In order: the blend that hides a starved pool,
 * the scale filter that would delete the very rows being detected, and the
 * score comparison D-001 retracted.
 */
describe('recallPoolSignalsFromHealth (P-013)', () => {
  const pool = (over: Partial<RecallPoolHealth> = {}): RecallPoolHealth => ({
    surface: 'turn-start',
    pool: 'harness',
    scoreScale: 'rrf',
    recalls: 40,
    zeroHit: 0,
    zeroHitRate: 0,
    saturated: 0,
    saturationRate: 0,
    hitsP50: 4,
    topScoreP50: 0.03,
    scopes: ['harness:papercusp'],
    emptyScope: 0,
    emptyScopeRate: 0,
    ...over,
  });
  const surface = (over: Partial<RecallSurfaceHealth> = {}): RecallSurfaceHealth => ({
    surface: 'turn-start',
    recalls7d: 120,
    zeroHit7d: 0,
    zeroHitRate7d: 0,
    topScoreP50: 0.03,
    topScoreP90: 0.032,
    topScoreScale: 'rrf',
    topScoreSamples: 120,
    scaleMix: { rrf: 120 },
    fragmentHits7d: 0,
    ...over,
  });

  it('fires on a fully starved pool that the BLENDED surface rate reports as healthy', () => {
    // The live 2026-07-28 shape: one pool dead on every call, siblings filling
    // the block, so the surface itself never records a zero hit.
    const out = recallPoolSignalsFromHealth(
      [
        pool({ pool: 'user', recalls: 40, zeroHit: 40, zeroHitRate: 1 }),
        pool({ pool: 'harness' }),
        pool({ pool: 'hive' }),
      ],
      [surface({ zeroHitRate7d: 0 })],
    );
    const starved = out.find((s) => s.key === 'recall-pool-starved');
    expect(starved).toBeDefined();
    expect(starved!.body).toContain('turn-start/user');
    // The contrast clause is the whole argument for the detector existing.
    expect(starved!.body).toContain('BLENDED turn-start surface reads 0% zero-hit');
    // Scope keys travel with the finding — the unmigrated-rename signature.
    expect(starved!.body).toContain('harness:papercusp');
  });

  it('does NOT filter on score scale — an unknown-scale starved pool still fires', () => {
    // THE self-defeating filter. A legacy zero-hit row has top_score NULL and
    // therefore classifies as 'unknown', so excluding 'unknown' (correct for a
    // SCORE comparison) would delete exactly the starvation being detected.
    const out = recallPoolSignalsFromHealth(
      [pool({ pool: 'user', scoreScale: 'unknown', recalls: 40, zeroHit: 40, zeroHitRate: 1 })],
      [],
    );
    expect(out.map((s) => s.key)).toContain('recall-pool-starved');
    expect(out[0]!.body).toContain('[unknown]');
  });

  it('never emits a score-vs-floor comparison (the D-001 / D-023 class)', () => {
    const out = recallPoolSignalsFromHealth(
      [
        pool({ pool: 'user', recalls: 40, zeroHit: 40, zeroHitRate: 1 }),
        pool({ pool: 'hive', recalls: 40, saturated: 40, saturationRate: 1 }),
      ],
      [surface()],
    );
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) {
      // 0.45 is the cosine admission floor. A push-path top_score is a
      // post-fusion RRF rank, so comparing the two is the retracted unit error;
      // this detector is count-based and must never reference the floor.
      expect(s.body).not.toContain('0.45');
      expect(s.body.toLowerCase()).not.toContain('below the floor');
    }
  });

  it('ignores slices below the minimum sample rather than firing on 2 recalls', () => {
    expect(
      recallPoolSignalsFromHealth([pool({ pool: 'user', recalls: 2, zeroHit: 2, zeroHitRate: 1 })], []),
    ).toEqual([]);
  });

  it('stays quiet on pools that are merely quiet', () => {
    expect(
      recallPoolSignalsFromHealth(
        [pool({ zeroHitRate: 0.25, zeroHit: 10 }), pool({ pool: 'hive', saturationRate: 0.5 })],
        [surface()],
      ),
    ).toEqual([]);
  });

  it('reports saturation as its own signal, separate from starvation', () => {
    const out = recallPoolSignalsFromHealth(
      [pool({ pool: 'user', recalls: 27, saturated: 24, saturationRate: 24 / 27 })],
      [surface()],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe('recall-pool-saturated');
    expect(out[0]!.body).toContain('filled its budget on 24/27');
  });

  it('emits both signals independently when both conditions hold', () => {
    const out = recallPoolSignalsFromHealth(
      [
        pool({ pool: 'user', recalls: 40, zeroHit: 40, zeroHitRate: 1 }),
        pool({ pool: 'hive', recalls: 40, saturated: 39, saturationRate: 39 / 40 }),
      ],
      [surface()],
    );
    expect(out.map((s) => s.key).sort()).toEqual(['recall-pool-saturated', 'recall-pool-starved']);
  });

  it('works without surface data — the contrast clause is annotation, not a gate', () => {
    const out = recallPoolSignalsFromHealth(
      [pool({ pool: 'user', recalls: 40, zeroHit: 40, zeroHitRate: 1 })],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.body).not.toContain('BLENDED');
  });

  it('keeps counts OUT of the title so search-first dedup matches across ticks', () => {
    const out = recallPoolSignalsFromHealth(
      [pool({ pool: 'user', recalls: 40, zeroHit: 40, zeroHitRate: 1 })],
      [],
    );
    expect(out[0]!.title).toBe('Memory recall: an injection pool returns nothing on nearly every call');
    expect(out[0]!.title).not.toMatch(/\d/);
  });

  it('honours the tunables rather than hardcoding the thresholds', () => {
    const rows = [pool({ pool: 'user', recalls: 40, zeroHit: 36, zeroHitRate: 0.9 })];
    expect(recallPoolSignalsFromHealth(rows, [], { recallPoolMaxZeroHitRate: 0.95 })).toEqual([]);
    expect(recallPoolSignalsFromHealth(rows, [], { recallPoolMaxZeroHitRate: 0.5 })).toHaveLength(1);
    expect(recallPoolSignalsFromHealth(rows, [], { recallPoolMinRecalls: 100 })).toEqual([]);
    // The defaults are the ones the collector ships with.
    expect(LEARNING_SLO_DEFAULTS.recallPoolMaxZeroHitRate).toBe(0.85);
    expect(LEARNING_SLO_DEFAULTS.recallPoolMinRecalls).toBe(20);
  });
});

/*
 * recall-pool gate-3 + recall-scale gate-5 (context-injection-audit-2026-07-28
 * P-037 / F-G, D-035).
 *
 * Same posture as the P-013 block above: these are the traps, not arithmetic
 * coverage. The load-bearing case is the FIRST — the entire reason gate-3
 * exists is that the offending pools sit UNDER the gate-2 threshold, so a test
 * that only proved "empty scope fires" while the pool was ALSO starved would
 * pass against a detector that added nothing.
 */
describe('recall empty-scope + scale-contradiction (P-037)', () => {
  const pool = (over: Partial<RecallPoolHealth> = {}): RecallPoolHealth => ({
    surface: 'turn-start',
    pool: 'harness',
    scoreScale: 'rrf',
    recalls: 40,
    zeroHit: 0,
    zeroHitRate: 0,
    saturated: 0,
    saturationRate: 0,
    hitsP50: 4,
    topScoreP50: 0.03,
    scopes: ['harness:papercusp'],
    emptyScope: 0,
    emptyScopeRate: 0,
    ...over,
  });

  it('fires BELOW the gate-2 starvation threshold — the case nothing could see before', () => {
    // The live 2026-08-01 shape: turn-start/harness asked unscoped on 68.8% of
    // recalls, zero-hit 73.6% — under the 0.85 starvation gate.
    const out = recallPoolSignalsFromHealth([
      pool({ recalls: 455, zeroHit: 335, zeroHitRate: 0.736, emptyScope: 313, emptyScopeRate: 0.688 }),
    ]);
    const keys = out.map((s) => s.key);
    expect(keys).toContain('recall-pool-empty-scope');
    // The proof the new gate is load-bearing: gate-2 stays silent on this row.
    expect(keys).not.toContain('recall-pool-starved');
    expect(out[0]?.body).toContain('UNDER the 85% starvation gate');
  });

  it('does NOT fire on a pool asked under a real scope every time', () => {
    // initialize/harness, live: 98.8% zero-hit but 0% empty-scope. gate-2's
    // business, emphatically not gate-3's — the opposite remedy.
    const out = recallPoolSignalsFromHealth([
      pool({ surface: 'initialize', recalls: 82, zeroHit: 81, zeroHitRate: 0.988 }),
    ]);
    const keys = out.map((s) => s.key);
    expect(keys).toContain('recall-pool-starved');
    expect(keys).not.toContain('recall-pool-empty-scope');
    // The starvation body must NAME the distinction, so the reader is not left
    // guessing between "fix the caller" and "fix the corpus".
    expect(out[0]?.body).toContain('genuine miss, not an unscoped call');
  });

  it('reports both gates separately when a pool trips both, and names the caller as the fix', () => {
    // claim/user, live: 100% empty-scope AND 100% zero-hit.
    const out = recallPoolSignalsFromHealth([
      pool({
        surface: 'claim', pool: 'user', recalls: 193,
        zeroHit: 193, zeroHitRate: 1, emptyScope: 193, emptyScopeRate: 1,
      }),
    ]);
    expect(out.map((s) => s.key).sort()).toEqual(['recall-pool-empty-scope', 'recall-pool-starved']);
    expect(out.find((s) => s.key === 'recall-pool-starved')?.body).toContain('fix the CALLER, not the corpus');
  });

  it('stays silent on a healthy pool', () => {
    expect(recallPoolSignalsFromHealth([pool()])).toEqual([]);
  });

  it('respects the min-recalls floor — an underpowered slice is not evidence', () => {
    expect(recallPoolSignalsFromHealth([pool({ recalls: 5, emptyScope: 5, emptyScopeRate: 1 })])).toEqual([]);
  });

  it('honours the empty-scope tunable rather than hardcoding it', () => {
    const rows = [pool({ recalls: 40, emptyScope: 16, emptyScopeRate: 0.4 })];
    expect(recallPoolSignalsFromHealth(rows, [], { recallPoolMaxEmptyScopeRate: 0.5 })).toEqual([]);
    expect(recallPoolSignalsFromHealth(rows, [], { recallPoolMaxEmptyScopeRate: 0.3 })).toHaveLength(1);
    expect(LEARNING_SLO_DEFAULTS.recallPoolMaxEmptyScopeRate).toBe(0.25);
  });

  it('flags an rrf row above the rrf ceiling', () => {
    const out = recallScaleSignalsFromContradictions([{
      surface: 'turn-start', declaredScale: 'rrf', rows: 100,
      contradicting: 4, contradictionRate: 0.04, minOffending: 0.61, maxOffending: 0.9,
    }]);
    expect(out).toHaveLength(1);
    expect(out[0]?.key).toBe('recall-scale-contradiction');
    expect(out[0]?.body).toContain('above the rrf ceiling');
    expect(out[0]?.body).toContain('0.610000');
  });

  it('flags a cosine row below the admission floor', () => {
    const out = recallScaleSignalsFromContradictions([{
      surface: 'search', declaredScale: 'cosine', rows: 50,
      contradicting: 1, contradictionRate: 0.02, minOffending: 0.016, maxOffending: 0.016,
    }]);
    expect(out[0]?.body).toContain('below the cosine admission floor 0.45');
  });

  it('fires on a SINGLE contradicting row — no rate floor, unlike the count SLOs', () => {
    // Deliberate asymmetry with gates 2/3/4: a contradiction is arithmetically
    // impossible rather than merely unusual, so there is no noise to suppress.
    const out = recallScaleSignalsFromContradictions([{
      surface: 'orient', declaredScale: 'rrf', rows: 10_000,
      contradicting: 1, contradictionRate: 0.0001, minOffending: 0.7, maxOffending: 0.7,
    }]);
    expect(out).toHaveLength(1);
  });

  it('stays silent when nothing contradicts — the live state today', () => {
    expect(recallScaleSignalsFromContradictions([])).toEqual([]);
  });
});
