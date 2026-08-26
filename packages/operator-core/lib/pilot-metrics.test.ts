import { describe, it, expect } from 'vitest';

import {
  MIN_EVENTS_FOR_RATE,
  type ArmObservation,
  buildPilotReport,
  cohensD,
  countRareEvent,
  interpretationFor,
  meanCi95,
  sampleSd,
  summariseArm,
  tCritical95,
} from './pilot-metrics.js';
import { type PilotArm } from './pilot-arm-assignment.js';

const obs = (
  arm: PilotArm,
  score: number,
  over: Partial<ArmObservation> = {},
): ArmObservation => ({ itemId: `WI-${arm}${score}`, arm, score, ...over });

describe('rare events — D-022 enforced mechanically, not remembered', () => {
  it('WITHHOLDS the rate when too few events were observed', () => {
    // The whole point: a caller must not be able to obtain a "0% reopen rate" from 0/7,
    // because that number reads as a finding and is not one.
    const result = countRareEvent([false, false, false, false, false, false, false]);
    expect(result.events).toBe(0);
    expect(result.n).toBe(7);
    expect(result.rate).toBeNull();
    expect(result.rateWithheldReason).toMatch(/not an estimate/i);
  });

  it('still withholds just below the threshold', () => {
    const flags = Array.from({ length: 20 }, (_, i) => i < MIN_EVENTS_FOR_RATE - 1);
    expect(countRareEvent(flags).rate).toBeNull();
  });

  it('reports the rate once enough events exist', () => {
    const flags = Array.from({ length: 20 }, (_, i) => i < MIN_EVENTS_FOR_RATE);
    const result = countRareEvent(flags);
    expect(result.events).toBe(MIN_EVENTS_FOR_RATE);
    expect(result.rate).toBeCloseTo(MIN_EVENTS_FOR_RATE / 20, 10);
    expect(result.rateWithheldReason).toBeUndefined();
  });

  it('never reports null as zero — the two are different readings', () => {
    expect(countRareEvent([false, false]).rate).not.toBe(0);
  });
});

describe('cost attribution — the arm-C correction', () => {
  it('sums EVERY participating agent, so the pair is not reported at half price', () => {
    // A collector that counted one agent per item would report arm C at roughly half its
    // true cost and invert the pilot's entire cost-benefit question.
    const summary = summariseArm('C', [
      obs('C', 4, { agentCostsUsd: [1.0, 1.5] }), // director + implementer
      obs('C', 5, { agentCostsUsd: [2.0, 2.5] }),
    ]);
    expect(summary.totalCostUsd).toBeCloseTo(7.0, 10);
    expect(summary.meanCostPerItemUsd).toBeCloseTo(3.5, 10);
  });

  it('handles a single-agent arm without special-casing', () => {
    const summary = summariseArm('A', [
      obs('A', 3, { agentCostsUsd: [1.0] }),
      obs('A', 4, { agentCostsUsd: [3.0] }),
    ]);
    expect(summary.totalCostUsd).toBeCloseTo(4.0, 10);
  });

  it('reports null cost rather than 0 when nothing was recorded', () => {
    expect(summariseArm('A', [obs('A', 3)]).totalCostUsd).toBeNull();
  });
});

describe('statistics', () => {
  it('computes sample SD with n-1 and refuses below two observations', () => {
    expect(sampleSd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(sampleSd([5])).toBeNull();
    expect(sampleSd([])).toBeNull();
  });

  it('uses the t distribution, not 1.96, at the small df the pilot lives at', () => {
    // At df=6 the true critical value is 2.447; using 1.96 would report intervals ~25% too
    // narrow and make a null look like a finding.
    expect(tCritical95(6)).toBeCloseTo(2.447, 3);
    expect(tCritical95(12)).toBeCloseTo(2.179, 3);
    expect(tCritical95(6)).toBeGreaterThan(1.96);
    expect(tCritical95(1000)).toBeCloseTo(1.96, 3);
  });

  it('builds a CI that brackets the mean and widens with spread', () => {
    const tight = meanCi95([5, 5, 5, 5, 5, 5, 6])!;
    const loose = meanCi95([1, 9, 2, 8, 3, 7, 5])!;
    expect(tight[0]).toBeLessThan(tight[1]);
    expect(loose[1] - loose[0]).toBeGreaterThan(tight[1] - tight[0]);
    expect(meanCi95([5])).toBeNull();
  });

  it('computes a signed Cohen d against the baseline', () => {
    const worse = cohensD([5, 5, 5, 6, 5, 5, 5], [1, 1, 2, 1, 1, 1, 1])!;
    const better = cohensD([1, 1, 2, 1, 1, 1, 1], [5, 5, 5, 6, 5, 5, 5])!;
    expect(worse).toBeLessThan(0);
    expect(better).toBeGreaterThan(0);
    expect(Math.abs(better)).toBeCloseTo(Math.abs(worse), 6);
  });

  it('returns null rather than Infinity when both arms are constant', () => {
    // Pooled SD is 0 here; a naive implementation divides by zero and reports Infinity,
    // which downstream reads as an enormous effect.
    expect(cohensD([5, 5, 5], [7, 7, 7])).toBeNull();
  });
});

describe('buildPilotReport', () => {
  const cohort: ArmObservation[] = [
    ...[3, 4, 3, 4, 3, 4, 3].map((s) => obs('A', s, { agentCostsUsd: [1] })),
    ...[4, 4, 5, 4, 4, 5, 4].map((s) => obs('B', s, { agentCostsUsd: [1.1] })),
    ...[5, 5, 5, 4, 5, 5, 5].map((s) => obs('C', s, { agentCostsUsd: [1, 1] })),
  ];

  it('summarises every arm and sizes the effect against the solo baseline', () => {
    const report = buildPilotReport(cohort);
    expect(report.arms.A.n).toBe(7);
    expect(report.arms.C.n).toBe(7);
    expect(report.effectVsBaseline.B).toBeGreaterThan(0);
    expect(report.effectVsBaseline.C).toBeGreaterThan(0);
    // The pair costs roughly double per item — the number the quality gain must justify.
    expect(report.arms.C.meanCostPerItemUsd! / report.arms.A.meanCostPerItemUsd!)
      .toBeCloseTo(2, 1);
  });

  it('withholds every rare-event rate at pilot size', () => {
    const report = buildPilotReport(cohort);
    for (const arm of ['A', 'B', 'C'] as const) {
      expect(report.arms[arm].reopened.rate).toBeNull();
      expect(report.arms[arm].authorityProposed.rate).toBeNull();
    }
  });

  it('derives the interpretation from the ACHIEVED n, not the planned one', () => {
    // An early-stopped pilot must not inherit the plan's power claim. Stop arm C after
    // three items and the report must describe a 3-item arm, not a 7-item one.
    const stopped = buildPilotReport([
      ...cohort.filter((o) => o.arm !== 'C'),
      ...cohort.filter((o) => o.arm === 'C').slice(0, 3),
    ]);
    expect(stopped.interpretation).toContain('n=3');
    expect(stopped.interpretation).toContain('2.0'); // the weaker detectable effect
    expect(buildPilotReport(cohort).interpretation).toContain('n=7');
  });

  it('refuses to conclude anything when an arm is entirely empty', () => {
    const noC = buildPilotReport(cohort.filter((o) => o.arm !== 'C'));
    expect(noC.interpretation).toMatch(/nothing can be concluded/i);
    expect(noC.effectVsBaseline.C).toBeNull();
  });
});

describe('interpretationFor — the sentence that keeps a null from being misread', () => {
  it('always states that a null is not evidence of equality', () => {
    for (const n of [1, 7, 12, 26, 60]) {
      expect(interpretationFor(n)).toMatch(/NO LARGE EFFECT WAS DETECTED/);
      expect(interpretationFor(n)).toMatch(/not evidence that the arms/i);
    }
  });

  it('reports a smaller detectable effect as the arm grows', () => {
    const at7 = interpretationFor(7);
    const at26 = interpretationFor(26);
    expect(at7).toContain('1.6');
    expect(at26).toContain('0.8');
  });

  it('says plainly that nothing can be concluded from an empty pilot', () => {
    expect(interpretationFor(0)).toMatch(/nothing can be concluded/i);
  });
});
