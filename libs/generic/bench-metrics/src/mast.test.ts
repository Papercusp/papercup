import { describe, it, expect } from 'vitest';
import {
  scoreMast,
  substrateSignalRates,
  MAST_MODES,
  MAST_CATEGORIES,
  MAS_FAILURE_BASELINE_BAND,
  type MastVerdict,
  type CoordEvent,
} from './mast';

describe('MAST taxonomy', () => {
  it('re-implements the 3 categories × 14 modes', () => {
    expect(MAST_CATEGORIES).toHaveLength(3);
    expect(MAST_MODES).toHaveLength(14);
    expect(MAST_MODES.filter((m) => m.category === 'specification-system-design')).toHaveLength(5);
    expect(MAST_MODES.filter((m) => m.category === 'inter-agent-misalignment')).toHaveLength(6);
    expect(MAST_MODES.filter((m) => m.category === 'task-verification')).toHaveLength(3);
    expect(MAS_FAILURE_BASELINE_BAND).toEqual([0.41, 0.86]);
  });
});

describe('substrateSignalRates (objective, no judge)', () => {
  it('counts mechanical failure signals and normalizes per task', () => {
    const events: CoordEvent[] = [
      { kind: 'duplicate_completion' },
      { kind: 'orphaned_claim' },
      { kind: 'claim_conflict' },
      { kind: 'rework' },
      { kind: 'handoff' }, // clean action — volume only
      { kind: 'complete' },
    ];
    const r = substrateSignalRates(events, 10);
    expect(r.counts).toEqual({ duplicate: 1, breakdown: 1, misalignment: 1, redundant: 1 });
    expect(r.duplicationRate).toBeCloseTo(0.1, 10);
    expect(r.coordinationBreakdownRate).toBeCloseTo(0.1, 10);
    expect(r.misalignmentRate).toBeCloseTo(0.1, 10);
    expect(r.redundantWorkRate).toBeCloseTo(0.1, 10);
    expect(r.coordinationActions).toBe(6);
  });
});

describe('scoreMast', () => {
  it('scores judge verdicts into per-mode, per-category, and overall rates', () => {
    const verdicts: MastVerdict[] = [
      { mode: '1.1', failed: true },
      { mode: '1.1', failed: false }, // mode 1.1 → 1/2
      { mode: '2.4', failed: true }, // mode 2.4 → 1/1
      { mode: '3.1', failed: false }, // mode 3.1 → 0/1
    ];
    const r = scoreMast({ arm: 'hive', tasks: 4, verdicts });
    expect(r.byMode!['1.1']).toBeCloseTo(0.5, 10);
    expect(r.byMode!['2.4']).toBeCloseTo(1, 10);
    expect(r.byMode!['3.1']).toBe(0);
    expect(r.byCategory!['specification-system-design']).toBeCloseTo(0.5, 10); // 1 failed / 2 verdicts
    expect(r.byCategory!['inter-agent-misalignment']).toBeCloseTo(1, 10);
    expect(r.byCategory!['task-verification']).toBe(0);
    expect(r.overallFailureRate).toBeCloseTo(0.5, 10); // 2/4
    expect(r.substrate).toBeNull();
  });

  it('scores a trace-only run into substrate rates with judge fields null', () => {
    const r = scoreMast({ arm: 'queen-ablated', tasks: 5, trace: [{ kind: 'duplicate_completion' }] });
    expect(r.byCategory).toBeNull();
    expect(r.byMode).toBeNull();
    expect(r.overallFailureRate).toBeNull();
    expect(r.substrate!.duplicationRate).toBeCloseTo(0.2, 10);
  });

  it('returns all-null when neither verdicts nor trace are given', () => {
    const r = scoreMast({ arm: 'hive', tasks: 3 });
    expect(r.byCategory).toBeNull();
    expect(r.overallFailureRate).toBeNull();
    expect(r.substrate).toBeNull();
    expect(r.masBaselineBand).toEqual([0.41, 0.86]);
  });
});
