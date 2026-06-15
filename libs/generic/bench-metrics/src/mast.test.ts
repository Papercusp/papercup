import { describe, it, expect } from 'vitest';
import {
  scoreMast,
  substrateSignalRates,
  buildMastJudgePrompt,
  mockMastJudge,
  MAST_MODES,
  MAST_CATEGORIES,
  MAS_FAILURE_BASELINE_BAND,
  type MastVerdict,
  type CoordEvent,
  type CoordTrace,
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

describe('buildMastJudgePrompt', () => {
  it('renders the 14-mode rubric + the chronological trace + a structured-output ask', () => {
    const trace: CoordTrace = {
      arm: 'hive',
      agents: ['queen', 'bee-1'],
      events: [
        { ts: 1, kind: 'placement', agent: 'queen', taskId: 't1' },
        { ts: 2, kind: 'duplicate_completion', agent: 'bee-1', taskId: 't1', detail: 'redone' },
      ],
    };
    const p = buildMastJudgePrompt(trace);
    expect(p).toContain('Arm: hive');
    expect(p).toContain('queen, bee-1');
    // every mode id appears in the rubric
    for (const m of MAST_MODES) expect(p).toContain(m.id);
    expect(p).toContain('duplicate_completion');
    expect(p).toContain('"failed"');
  });

  it('handles an empty trace', () => {
    expect(buildMastJudgePrompt({ arm: 'queen-ablated', events: [] })).toContain('(no events)');
  });
});

describe('mockMastJudge', () => {
  it('emits one verdict per mode, failing modes evidenced by substrate signals', () => {
    const verdicts = mockMastJudge([
      { kind: 'duplicate_completion', taskId: 't1' }, // → mode 1.3
      { kind: 'orphaned_claim', taskId: 't2' }, // → mode 2.4
    ]);
    expect(verdicts).toHaveLength(14);
    const byMode = new Map(verdicts.map((v) => [v.mode, v]));
    expect(byMode.get('1.3')!.failed).toBe(true);
    expect(byMode.get('1.3')!.taskId).toBe('t1');
    expect(byMode.get('2.4')!.failed).toBe(true);
    expect(byMode.get('1.1')!.failed).toBe(false); // no evidence
    // round-trips through scoreMast
    const r = scoreMast({ arm: 'hive', tasks: 2, verdicts });
    expect(r.byMode!['1.3']).toBe(1);
    expect(r.byCategory!['specification-system-design']).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const ev: CoordEvent[] = [{ kind: 'claim_conflict' }];
    expect(mockMastJudge(ev)).toEqual(mockMastJudge(ev));
  });
});
