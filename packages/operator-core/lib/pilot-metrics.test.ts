import { describe, it, expect } from 'vitest';

import {
  DEFAULT_ADAPTIVE_TIER_POLICY,
  MIN_EVENTS_FOR_RATE,
  PILOT_LARGE_EFFECT_D,
  PILOT_MIN_ARM_N,
  PILOT_MIN_SCORE_DELTA,
  type ArmObservation,
  buildPilotReport,
  cohensD,
  countRareEvent,
  deriveAdaptiveTierGate,
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
    expect(report.arms.A.scoredN).toBe(7);
    expect(report.arms.A.costedN).toBe(7);
    expect(report.arms.C.n).toBe(7);
    expect(report.effectVsBaseline.B).toBeGreaterThan(0);
    expect(report.effectVsBaseline.C).toBeGreaterThan(0);
    expect(report.effectVsReviewGate.C).toBeGreaterThan(0);
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

describe('deriveAdaptiveTierGate — D-033 preregistered verdict', () => {
  const arm = (
    label: PilotArm,
    scores: readonly number[],
    cost: number,
    over: Partial<ArmObservation> = {},
  ): ArmObservation[] => scores.map((score, i) => obs(label, score, {
    itemId: `WI-${label}-${i}`,
    agentCostsUsd: label === 'C' ? [cost / 2, cost / 2] : [cost],
    ...over,
  }));

  const report = (
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    costs: readonly [number, number, number] = [1, 1.1, 2],
    over: Partial<ArmObservation> = {},
  ) => buildPilotReport([
    ...arm('A', a, costs[0], over),
    ...arm('B', b, costs[1], over),
    ...arm('C', c, costs[2], over),
  ]);

  const a = [5, 6, 5, 6, 5, 6, 5];
  const b = [5, 6, 6, 5, 6, 5, 6];
  const c = [8, 9, 8, 9, 8, 9, 8];

  it('pins the thresholds to D-022 and preserves D-007 as the default policy', () => {
    expect(PILOT_MIN_ARM_N).toBe(7);
    expect(PILOT_LARGE_EFFECT_D).toBe(1.6);
    expect(PILOT_MIN_SCORE_DELTA).toBe(1);
    expect(DEFAULT_ADAPTIVE_TIER_POLICY).toEqual({ trivial: 'A', substantive: 'B', highRisk: 'C' });
  });

  it('promotes substantive work to C only for a large, cost-justified C-over-B effect', () => {
    const decision = deriveAdaptiveTierGate(report(a, b, c), { collectionComplete: true });
    expect(decision.status).toBe('ready');
    expect(decision.policy.substantive).toBe('C');
    expect(decision.comparisons.cVsB.largePositiveEffect).toBe(true);
    expect(decision.comparisons.cVsB.costJustified).toBe(true);
  });

  it('retains B when the quality effect is large but its incremental price is too high', () => {
    const decision = deriveAdaptiveTierGate(report(a, b, c, [1, 1.1, 6]), {
      collectionComplete: true,
    });
    expect(decision.status).toBe('ready');
    expect(decision.policy.substantive).toBe('B');
    expect(decision.comparisons.cVsB.largePositiveEffect).toBe(true);
    expect(decision.comparisons.cVsB.costJustified).toBe(false);
  });

  it('demotes substantive work to A only when B shows preregistered large harm', () => {
    const harmedB = [2, 3, 2, 3, 2, 3, 2];
    const similarC = [2, 3, 3, 2, 3, 2, 3];
    const decision = deriveAdaptiveTierGate(report(a, harmedB, similarC), {
      collectionComplete: true,
    });
    expect(decision.status).toBe('ready');
    expect(decision.policy.substantive).toBe('A');
    expect(decision.comparisons.bVsA.largeNegativeEffect).toBe(true);
  });

  it('preserves B on an inconclusive screening result instead of reading null as parity', () => {
    const nearB = [5, 6, 5, 6, 6, 5, 6];
    const nearC = [6, 5, 6, 5, 6, 5, 6];
    const decision = deriveAdaptiveTierGate(report(a, nearB, nearC), {
      collectionComplete: true,
    });
    expect(decision.status).toBe('ready');
    expect(decision.policy.substantive).toBe('B');
    expect(decision.defaultPreserved).toBe(true);
    expect(decision.reason).toMatch(/inconclusive screening result is not parity/i);
  });

  it('fails closed when collection, score, cost, or achieved-n evidence is incomplete', () => {
    const observations = [
      ...arm('A', a, 1),
      ...arm('B', b, 1.1),
      ...arm('C', c.slice(0, 6), 2),
    ];
    observations[0] = { ...observations[0], agentCostsUsd: undefined };
    const decision = deriveAdaptiveTierGate(buildPilotReport(observations), {
      collectionComplete: false,
    });
    expect(decision.status).toBe('insufficient-evidence');
    expect(decision.policy).toEqual(DEFAULT_ADAPTIVE_TIER_POLICY);
    expect(decision.readinessIssues).toEqual(expect.arrayContaining([
      expect.stringMatching(/typed evidence gaps/i),
      expect.stringMatching(/arm A has costs for 6\/7/i),
      expect.stringMatching(/arm C achieved n=6/i),
    ]));
  });

  it('requires individual rare-event adjudication before changing the policy', () => {
    const observations = [
      ...arm('A', a, 1),
      ...arm('B', b, 1.1),
      ...arm('C', c, 2),
    ];
    observations[0] = { ...observations[0], reopened: true };
    const pilot = buildPilotReport(observations);
    const held = deriveAdaptiveTierGate(pilot, { collectionComplete: true });
    const cleared = deriveAdaptiveTierGate(pilot, {
      collectionComplete: true,
      tripwiresAdjudicated: true,
    });
    expect(held.status).toBe('tripwire-review');
    expect(held.policy).toEqual(DEFAULT_ADAPTIVE_TIER_POLICY);
    expect(cleared.status).toBe('ready');
    expect(cleared.policy.substantive).toBe('C');
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
