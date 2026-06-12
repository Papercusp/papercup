/**
 * Drill-ground-truth signal cores + their GYM_SIGNAL_REGISTRY entries
 * (self-learning-frontier P-048 / FB-23). Pins: the rate math (settled-only /
 * pinned-decision-only denominators), the MTTSH preference order (measured
 * totalMs over timestamp delta), the D-002 provenance guard (a non-drill row
 * never enters a drill metric), and the registry's inapplicable-not-fake-zero
 * discipline with the `metric` ride-along.
 */
import { describe, test, expect } from 'vitest';
import {
  drillResolveRate,
  drillTriageAccuracy,
  drillMttshMs,
  onlyDrillRows,
  DRILL_RESOLVE_RATE_FLOOR,
  DRILL_MTTSH_CEILING_MS,
  type DrillOutcome,
} from '../drill-signals';
import { GYM_SIGNAL_REGISTRY, knownSignals, evaluateSignals } from '../primitives';

const T0 = '2026-06-12T00:00:00.000Z';

/** A resolved-with-evidence drill; override per case. */
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

describe('drillResolveRate', () => {
  test('resolved-with-evidence over settled drills; in-flight rows are excluded', () => {
    const outcomes = [
      drill(),
      drill({ drillId: 'd-2', status: 'failed', resolvedWithEvidence: false, resolvedAt: null }),
      drill({ drillId: 'd-3', status: 'expired', resolvedWithEvidence: false, resolvedAt: null }),
      // in-flight — not yet scoreable, must not deflate the rate:
      drill({ drillId: 'd-4', status: 'detected', resolvedWithEvidence: false, resolvedAt: null }),
    ];
    expect(drillResolveRate(outcomes)).toBeCloseTo(1 / 3);
  });

  test('resolved WITHOUT evidence does not count as a pass', () => {
    expect(drillResolveRate([drill({ resolvedWithEvidence: false })])).toBe(0);
  });

  test('null (not 0) when nothing has settled', () => {
    expect(drillResolveRate([])).toBeNull();
    expect(drillResolveRate([drill({ status: 'planted', resolvedAt: null })])).toBeNull();
  });
});

describe('drillTriageAccuracy', () => {
  test('decision match over drills with BOTH a pinned expectation and an actual triage', () => {
    const outcomes = [
      drill({ expectedDecision: 'place', triagedDecision: 'place' }),
      drill({ drillId: 'd-2', expectedDecision: 'gate', triagedDecision: 'place' }),
      // no pinned expectation → not in the denominator:
      drill({ drillId: 'd-3', triagedDecision: 'reject' }),
      // not yet triaged → not in the denominator:
      drill({ drillId: 'd-4', expectedDecision: 'gym' }),
    ];
    expect(drillTriageAccuracy(outcomes)).toBeCloseTo(0.5);
  });

  test('null when no drill is scoreable', () => {
    expect(drillTriageAccuracy([drill()])).toBeNull();
  });
});

describe('drillMttshMs', () => {
  test('prefers the measured mttsh.totalMs over the timestamp delta', () => {
    const outcomes = [drill({ mttsh: { totalMs: 60_000 } })]; // timestamps say 30 min
    expect(drillMttshMs(outcomes)).toBe(60_000);
  });

  test('falls back to plantedAt→resolvedAt and averages across resolved drills', () => {
    const outcomes = [
      drill(), // 30 min by timestamps
      drill({ drillId: 'd-2', mttsh: { totalMs: 600_000 } }), // 10 min measured
    ];
    expect(drillMttshMs(outcomes)).toBe((30 * 60_000 + 600_000) / 2);
  });

  test('unresolved / no-evidence drills contribute nothing; null when empty', () => {
    expect(drillMttshMs([drill({ status: 'failed', resolvedWithEvidence: false })])).toBeNull();
  });
});

describe('provenance guard (D-002)', () => {
  test('a non-drill row never enters a drill metric', () => {
    const organic = drill({ drillId: 'leak', origin: 'organic' as DrillOutcome['origin'] });
    expect(onlyDrillRows([organic])).toEqual([]);
    expect(drillResolveRate([organic])).toBeNull();
    expect(drillMttshMs([organic])).toBeNull();
    expect(drillTriageAccuracy([organic, drill({ expectedDecision: 'place', triagedDecision: 'place' })])).toBe(1);
  });
});

describe('GYM_SIGNAL_REGISTRY drill entries', () => {
  test('the three drill signals are nameable from a blueprint', () => {
    for (const name of ['drillResolveRate', 'drillTriageAccuracy', 'drillMttsh']) {
      expect(knownSignals()).toContain(name);
    }
  });

  test('inapplicable (never a fake failure) without drill outcomes', () => {
    const { results, unknown } = evaluateSignals(['drillResolveRate', 'drillTriageAccuracy', 'drillMttsh'], {});
    expect(unknown).toEqual([]);
    for (const r of results) expect(r.applicable).toBe(false);
  });

  test('value = SLO verdict, metric = the raw scalar', () => {
    const pass = GYM_SIGNAL_REGISTRY.drillResolveRate({ drillOutcomes: [drill()] });
    expect(pass).toMatchObject({ applicable: true, value: true, metric: 1 });

    const fail = GYM_SIGNAL_REGISTRY.drillResolveRate({
      drillOutcomes: [drill({ resolvedWithEvidence: false })],
    });
    expect(fail.applicable).toBe(true);
    expect(fail.value).toBe(false); // 0 < DRILL_RESOLVE_RATE_FLOOR
    expect(fail.metric).toBe(0);
    expect(DRILL_RESOLVE_RATE_FLOOR).toBeGreaterThan(0);

    const slow = GYM_SIGNAL_REGISTRY.drillMttsh({
      drillOutcomes: [drill({ mttsh: { totalMs: DRILL_MTTSH_CEILING_MS + 1 } })],
    });
    expect(slow.value).toBe(false);
    expect(slow.metric).toBe(DRILL_MTTSH_CEILING_MS + 1);
  });
});
