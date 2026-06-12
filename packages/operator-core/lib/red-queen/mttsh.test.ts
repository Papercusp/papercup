/**
 * mttsh.test.ts — the pure MTTSH vital-sign aggregation
 * (self-learning-frontier P-031 / FB-20).
 */
import { describe, expect, it } from 'vitest';
import { computeMttshVitals, EMPTY_MTTSH_VITALS } from './mttsh';
import type { DrillOutcome } from './types';

const base = (over: Partial<DrillOutcome>): DrillOutcome => ({
  drillId: 'd-1',
  drillClass: 'smoke-fail',
  collectorFamily: 'smoke-fail',
  plantedAt: '2026-06-12T10:00:00.000Z',
  expectedWatchdogKey: 'smoke-fail:red-queen-sandbox',
  expectedKind: 'bug',
  expectedSeverity: 'major',
  resolvedWithEvidence: false,
  status: 'failed',
  origin: 'drill',
  ...over,
});

const resolved = (id: string, totalMs: number, over: Partial<DrillOutcome> = {}): DrillOutcome =>
  base({
    drillId: id,
    status: 'resolved',
    resolvedWithEvidence: true,
    mttsh: { detectMs: totalMs / 2, triageMs: totalMs / 4, fixMs: totalMs / 4, totalMs },
    leakCheckPassed: true,
    ...over,
  });

describe('computeMttshVitals', () => {
  it('no outcomes ⇒ the empty snapshot shape', () => {
    expect(computeMttshVitals([])).toEqual(EMPTY_MTTSH_VITALS);
  });

  it('aggregates per class: medians over RESOLVED runs only', () => {
    const v = computeMttshVitals([
      resolved('a', 100),
      resolved('b', 300),
      base({ drillId: 'c', status: 'failed' }), // failed runs never feed the medians
    ]);
    expect(v.totalRuns).toBe(3);
    expect(v.totalResolved).toBe(2);
    expect(v.medianTotalMs).toBe(200);
    expect(v.classes).toHaveLength(1);
    expect(v.classes[0]).toMatchObject({ drillClass: 'smoke-fail', runs: 3, resolved: 2, totalMs: 200 });
  });

  it('triage accuracy counts only runs that pin an expectation AND were triaged', () => {
    const v = computeMttshVitals([
      resolved('a', 100, { expectedDecision: 'place', triagedDecision: 'place' }),
      resolved('b', 100, { expectedDecision: 'place', triagedDecision: 'gate' }),
      resolved('c', 100, { triagedDecision: 'place' }), // no expectation — not judged
      base({ drillId: 'd', expectedDecision: 'place' }), // never triaged — not judged
    ]);
    expect(v.classes[0].triageJudged).toBe(2);
    expect(v.classes[0].triageMatches).toBe(1);
  });

  it('a failed leak check is a counted alarm, per class and overall', () => {
    const v = computeMttshVitals([
      resolved('a', 100),
      resolved('b', 100, { drillClass: 'stuck-plan', collectorFamily: 'stuck-plan', leakCheckPassed: false }),
    ]);
    expect(v.leakFailures).toBe(1);
    const stuck = v.classes.find((c) => c.drillClass === 'stuck-plan')!;
    expect(stuck.leakFailures).toBe(1);
  });

  it('lastRunAt is the newest plant across classes; classes sort by id', () => {
    const v = computeMttshVitals([
      resolved('a', 100, { drillClass: 'z-class', plantedAt: '2026-06-12T11:00:00.000Z' }),
      resolved('b', 100, { drillClass: 'a-class', plantedAt: '2026-06-12T12:00:00.000Z' }),
    ]);
    expect(v.lastRunAt).toBe('2026-06-12T12:00:00.000Z');
    expect(v.classes.map((c) => c.drillClass)).toEqual(['a-class', 'z-class']);
  });
});
