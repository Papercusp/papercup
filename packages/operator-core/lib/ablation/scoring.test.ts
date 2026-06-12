/**
 * scoring.test.ts — behavioral-delta verdicts + the dead-weight report
 * (FB-09 / P-023). Pure unit, zero IO.
 */
import { describe, expect, it } from 'vitest';

import {
  buildDeadWeightReport,
  scoreAblationCycle,
  type AblationRunSummary,
  type ScenarioArmOutcome,
} from './scoring';

function outcome(id: string, base: number | undefined, abl: number | undefined): ScenarioArmOutcome {
  return {
    scenarioId: id,
    baseline: base === undefined ? { error: 'arm errored' } : { passRate: base, judgeAxes: { tone: 4 } },
    ablated: abl === undefined ? { error: 'arm errored' } : { passRate: abl, judgeAxes: { tone: 3 } },
  };
}

describe('scoreAblationCycle', () => {
  it('load-bearing when the ablated arm regresses past the threshold', () => {
    const score = scoreAblationCycle([
      outcome('s1', 1, 0),
      outcome('s2', 1, 1),
      outcome('s3', 1, 1),
      outcome('s4', 1, 0),
    ]);
    expect(score.verdict).toBe('load-bearing');
    expect(score.passRateDelta).toBeCloseTo(-0.5);
    expect(score.regressions).toEqual(['s1', 's4']);
    expect(score.judgeAxisDeltas.tone).toBeCloseTo(-1);
  });

  it('no-delta inside the noise band; improved past the upper threshold (surfaced, not celebrated)', () => {
    const flat = scoreAblationCycle([outcome('s1', 1, 1), outcome('s2', 0, 0), outcome('s3', 1, 1), outcome('s4', 1, 1)]);
    expect(flat.verdict).toBe('no-delta');
    const better = scoreAblationCycle([outcome('s1', 0, 1), outcome('s2', 0, 1), outcome('s3', 1, 1), outcome('s4', 1, 1)]);
    expect(better.verdict).toBe('improved');
    expect(better.improvements).toEqual(['s1', 's2']);
  });

  it('inconclusive when too few scenario pairs are measurable (errors / budget cap)', () => {
    const score = scoreAblationCycle([
      outcome('s1', 1, 1),
      outcome('s2', 1, undefined),
      outcome('s3', undefined, 1),
    ]);
    expect(score.verdict).toBe('inconclusive');
    expect(score.measurableCount).toBe(1);
    expect(score.scenarioCount).toBe(3);
  });
});

function row(p: Partial<AblationRunSummary> & Pick<AblationRunSummary, 'ruleKey' | 'verdict' | 'finishedAt'>): AblationRunSummary {
  return {
    ruleHash: 'aaaaaaaaaaaa',
    ruleExcerpt: 'excerpt',
    passRateDelta: 0,
    capped: false,
    ...p,
  };
}

describe('buildDeadWeightReport', () => {
  it('promotes to dead-weight-candidate only after minRuns conclusive no-delta cycles on ONE wording', () => {
    const report = buildDeadWeightReport([
      row({ ruleKey: 'a/x', verdict: 'no-delta', finishedAt: '2026-06-01T00:00:00Z' }),
      row({ ruleKey: 'a/x', verdict: 'no-delta', finishedAt: '2026-06-08T00:00:00Z' }),
      row({ ruleKey: 'b/y', verdict: 'no-delta', finishedAt: '2026-06-08T00:00:00Z' }),
    ]);
    const x = report.find((e) => e.ruleKey === 'a/x')!;
    const y = report.find((e) => e.ruleKey === 'b/y')!;
    expect(x.status).toBe('dead-weight-candidate');
    expect(x.evidenceRuns).toBe(2);
    expect(y.status).toBe('insufficient-evidence');
    // candidates sort first — the owner review queue
    expect(report[0]!.ruleKey).toBe('a/x');
  });

  it('any load-bearing cycle pins the rule load-bearing; inconclusive cycles never count', () => {
    const report = buildDeadWeightReport([
      row({ ruleKey: 'a/x', verdict: 'no-delta', finishedAt: '2026-06-01T00:00:00Z' }),
      row({ ruleKey: 'a/x', verdict: 'load-bearing', finishedAt: '2026-06-08T00:00:00Z', passRateDelta: -0.4 }),
      row({ ruleKey: 'b/y', verdict: 'inconclusive', finishedAt: '2026-06-01T00:00:00Z' }),
      row({ ruleKey: 'b/y', verdict: 'inconclusive', finishedAt: '2026-06-08T00:00:00Z' }),
    ]);
    expect(report.find((e) => e.ruleKey === 'a/x')!.status).toBe('load-bearing');
    const y = report.find((e) => e.ruleKey === 'b/y')!;
    expect(y.status).toBe('insufficient-evidence');
    expect(y.evidenceRuns).toBe(0);
  });

  it('a reworded rule restarts its evidence (hash mismatch drops older cycles)', () => {
    const report = buildDeadWeightReport([
      row({ ruleKey: 'a/x', verdict: 'no-delta', finishedAt: '2026-06-01T00:00:00Z', ruleHash: 'oldhash000000' }),
      row({ ruleKey: 'a/x', verdict: 'no-delta', finishedAt: '2026-06-08T00:00:00Z', ruleHash: 'newhash000000' }),
    ]);
    const x = report.find((e) => e.ruleKey === 'a/x')!;
    expect(x.ruleHash).toBe('newhash000000');
    expect(x.evidenceRuns).toBe(1);
    expect(x.status).toBe('insufficient-evidence');
  });
});
