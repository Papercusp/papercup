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
  flowSignalsFromAggregate,
  governorStarvationSignals,
  medianOf,
  memoryZeroHitSignalsFromAggregate,
  mttshRegressionCollector,
  mttshSignalsFromWindows,
  normalizedTriageEntropy,
  triageEntropyCollector,
  triageEntropySignalsFromRows,
} from './learning-slo';

const decisions = (counts: Record<string, number>): { decision: string }[] =>
  Object.entries(counts).flatMap(([decision, n]) => Array.from({ length: n }, () => ({ decision })));

const loop = (over: Partial<LearningLoopRegistration> = {}): LearningLoopRegistration => ({
  workspaceId: 'ws',
  loopId: 'gym-autoloop',
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
