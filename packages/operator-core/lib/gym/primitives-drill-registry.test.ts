/**
 * primitives-drill-registry.test.ts — the three drill-rate signals
 * (drillResolveRate / drillTriageAccuracy / drillMttsh, primitives.ts ~127-141)
 * exercised THROUGH the registry surface `evaluateSignals`, not one layer down.
 *
 * drill-signals.test.ts pins the rate math and calls GYM_SIGNAL_REGISTRY entries
 * directly; this file pins the public `evaluateSignals([name], ctx)` contract per
 * signal:
 *   (a) absent drillOutcomes → {value:false, applicable:false} and NO `metric`,
 *   (b) above floor → {value:true, applicable:true, metric:<rate>},
 *   (c) below floor → value:false but applicable:true WITH metric present,
 *   (d) drillMttsh uses `<=` vs the ceiling (opposite direction — small is good).
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateSignals,
  DRILL_RESOLVE_RATE_FLOOR,
  DRILL_TRIAGE_ACCURACY_FLOOR,
  DRILL_MTTSH_CEILING_MS,
  type DrillOutcome,
} from './primitives';

const T0 = '2026-06-12T00:00:00.000Z';

function drill(over: Partial<DrillOutcome> = {}): DrillOutcome {
  return {
    drillId: 'd-1',
    drillClass: 'smoke-fail',
    collectorFamily: 'smoke',
    plantedAt: T0,
    resolvedAt: '2026-06-12T00:30:00.000Z',
    expectedWatchdogKey: 'smoke:fail',
    expectedKind: 'bug',
    expectedSeverity: 'high',
    resolvedWithEvidence: true,
    status: 'resolved',
    origin: 'drill',
    ...over,
  };
}

/** evaluateSignals always wraps one signal here → first (only) result. */
function evalOne(name: string, ctx: Parameters<typeof evaluateSignals>[1]) {
  const { results, unknown } = evaluateSignals([name], ctx);
  expect(unknown).toEqual([]); // these are all real registry names
  expect(results).toHaveLength(1);
  return results[0];
}

describe('drillResolveRate via evaluateSignals', () => {
  it('(a) absent drillOutcomes → inapplicable, no metric', () => {
    const r = evalOne('drillResolveRate', {});
    expect(r).toEqual({ name: 'drillResolveRate', value: false, applicable: false });
    expect(r.metric).toBeUndefined();
  });

  it('(b) above floor → value:true, applicable:true, metric is the rate', () => {
    // both settled drills resolved-with-evidence → rate 1.0 (≥ floor)
    const r = evalOne('drillResolveRate', { drillOutcomes: [drill(), drill({ drillId: 'd-2' })] });
    expect(r.applicable).toBe(true);
    expect(r.value).toBe(true);
    expect(r.metric).toBe(1);
    expect(r.metric!).toBeGreaterThanOrEqual(DRILL_RESOLVE_RATE_FLOOR);
  });

  it('(c) below floor → value:false but still applicable WITH metric', () => {
    // 0/1 resolved-with-evidence → rate 0 (< floor), still a real measurement
    const r = evalOne('drillResolveRate', { drillOutcomes: [drill({ resolvedWithEvidence: false })] });
    expect(r.applicable).toBe(true);
    expect(r.value).toBe(false);
    expect(r.metric).toBe(0);
    expect(r.metric!).toBeLessThan(DRILL_RESOLVE_RATE_FLOOR);
  });
});

describe('drillTriageAccuracy via evaluateSignals', () => {
  it('(a) absent drillOutcomes → inapplicable, no metric', () => {
    const r = evalOne('drillTriageAccuracy', {});
    expect(r).toEqual({ name: 'drillTriageAccuracy', value: false, applicable: false });
    expect(r.metric).toBeUndefined();
  });

  it('(b) above floor → value:true, applicable:true, metric is the accuracy', () => {
    // 1/1 decision-pinned + triaged matched → accuracy 1.0 (≥ floor)
    const r = evalOne('drillTriageAccuracy', {
      drillOutcomes: [drill({ expectedDecision: 'place', triagedDecision: 'place' })],
    });
    expect(r.applicable).toBe(true);
    expect(r.value).toBe(true);
    expect(r.metric).toBe(1);
    expect(r.metric!).toBeGreaterThanOrEqual(DRILL_TRIAGE_ACCURACY_FLOOR);
  });

  it('(c) below floor → value:false but still applicable WITH metric', () => {
    // 1/2 matched → accuracy 0.5 (< 0.8 floor)
    const r = evalOne('drillTriageAccuracy', {
      drillOutcomes: [
        drill({ expectedDecision: 'place', triagedDecision: 'place' }),
        drill({ drillId: 'd-2', expectedDecision: 'gate', triagedDecision: 'place' }),
      ],
    });
    expect(r.applicable).toBe(true);
    expect(r.value).toBe(false);
    expect(r.metric).toBeCloseTo(0.5);
    expect(r.metric!).toBeLessThan(DRILL_TRIAGE_ACCURACY_FLOOR);
  });
});

describe('drillMttsh via evaluateSignals (<= ceiling — opposite direction)', () => {
  it('(a) absent drillOutcomes → inapplicable, no metric', () => {
    const r = evalOne('drillMttsh', {});
    expect(r).toEqual({ name: 'drillMttsh', value: false, applicable: false });
    expect(r.metric).toBeUndefined();
  });

  it('(b) UNDER the ceiling → value:true (fast is good), applicable, metric in ms', () => {
    const fast = DRILL_MTTSH_CEILING_MS - 1;
    const r = evalOne('drillMttsh', { drillOutcomes: [drill({ mttsh: { totalMs: fast } })] });
    expect(r.applicable).toBe(true);
    expect(r.value).toBe(true); // ms <= ceiling
    expect(r.metric).toBe(fast);
    expect(r.metric!).toBeLessThanOrEqual(DRILL_MTTSH_CEILING_MS);
  });

  it('(c) OVER the ceiling → value:false but applicable WITH metric (the <= flips vs the rate floors)', () => {
    const slow = DRILL_MTTSH_CEILING_MS + 1;
    const r = evalOne('drillMttsh', { drillOutcomes: [drill({ mttsh: { totalMs: slow } })] });
    expect(r.applicable).toBe(true);
    expect(r.value).toBe(false); // ms > ceiling
    expect(r.metric).toBe(slow);
    expect(r.metric!).toBeGreaterThan(DRILL_MTTSH_CEILING_MS);
  });
});
