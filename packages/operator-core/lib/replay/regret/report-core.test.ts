/**
 * report-core.test.ts — the scored regret report's pure rendering + the
 * kind-fidelity classifier (frontier P-044 / FB-18): an error-loop divergence
 * pinning concrete erroring tools is bug-shaped; everything else stays the
 * judgment-shaped process counterfactual.
 */
import { describe, expect, it } from 'vitest';
import {
  bestReplayScore,
  classifyRegretFinding,
  regretReportBody,
  regretReportTitle,
  type RegretReportInput,
} from './report-core';

const finding = (over: Partial<RegretReportInput> = {}): RegretReportInput => ({
  runId: 'run-bad',
  harnessSlug: 'papercup',
  role: 'worker',
  badnessScore: 0.45,
  badnessReasons: ['status-failed'],
  divergenceTurn: 0,
  divergenceKind: 'error-loop',
  divergenceEvidence: { runLength: 3, tools: ['Bash'] },
  candidateChanges: [
    { id: 'stop-retry-ladder', title: 'Stop retrying', promptDelta: 'HARD RULE: stop.', rationale: 'r', fromTurn: 0 },
  ],
  replayScores: [{ candidateId: 'stop-retry-ladder', improvementScore: 0.8, summary: 'recovered', costUsd: 0.1 }],
  ...over,
});

describe('classifyRegretFinding (kind fidelity — frontier P-044 / FB-18)', () => {
  it('an error-loop with pinned tools is the bug shape: concrete erroring surface, clear correct state', () => {
    expect(classifyRegretFinding(finding())).toEqual({
      kind: 'bug',
      findingClass: 'regret:tool-error-loop',
      severity: 'major',
      errorTools: ['Bash'],
    });
  });

  it('behavioral divergences (repeat-loop / burn-inflection / rescue-marker) stay judgment-shaped changes', () => {
    for (const divergenceKind of ['repeat-loop', 'burn-inflection', 'rescue-marker']) {
      expect(
        classifyRegretFinding(finding({ divergenceKind, divergenceEvidence: { tool: 'Read', identicalCalls: 3 } })),
      ).toEqual({ kind: 'change', findingClass: 'regret:process-counterfactual', severity: 'minor', errorTools: [] });
    }
  });

  it('an error-loop WITHOUT pinned tools never upgrades — no named surface means no bug claim', () => {
    const c = classifyRegretFinding(finding({ divergenceEvidence: { runLength: 3 } }));
    expect(c.kind).toBe('change');
    expect(c.findingClass).toBe('regret:process-counterfactual');
  });
});

describe('report rendering follows the classification', () => {
  it('bug shape: title names the erroring tools, body carries the correct-state contract', () => {
    expect(regretReportTitle(finding())).toBe('Tool error loop: Bash failed repeatedly in a worker session');
    const body = regretReportBody(finding());
    expect(body).toContain('Correct state');
    expect(body).toContain('`Bash`');
    expect(body).toContain('origin=replay');
  });

  it('change shape: the what-would-have-helped title + body, no correct-state claim', () => {
    const f = finding({ divergenceKind: 'repeat-loop', divergenceEvidence: { tool: 'Read', identicalCalls: 3 } });
    expect(regretReportTitle(f)).toBe('Regret: worker session diverged (repeat-loop) — Stop retrying');
    expect(regretReportBody(f)).not.toContain('Correct state');
  });

  it('bestReplayScore picks the highest improvement', () => {
    const f = finding({
      replayScores: [
        { candidateId: 'a', improvementScore: 0.2, summary: 's', costUsd: 0.1 },
        { candidateId: 'b', improvementScore: 0.6, summary: 's', costUsd: 0.1 },
      ],
    });
    expect(bestReplayScore(f)?.candidateId).toBe('b');
  });
});
