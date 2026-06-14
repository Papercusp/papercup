/**
 * Anti-gaming invariants (HE-07, P-060) — a deliberately-BAD Hive run scores low on the RIGHT
 * axis, and every obvious gaming strategy is defeated by a SPECIFIC, deterministic metric.
 *
 * This is the un-gameable contract the whole battery rests on (D-002/D-003/D-005). Each `it` pins
 * ONE gaming strategy → the metric that defeats it, and is built from the REAL compute functions
 * (`computeEfficiencyMetrics`/`computeSpeedMetrics` over raw behavior/timings, plus the real
 * `detectFabrication`) — so it proves the whole behavior → metric → score path can't be gamed, not
 * just the scorer in isolation. The strategy → defeating-metric map:
 *
 *   - fast-but-garbage        → the OUTCOME GATE (D-002): efficiency/speed credit zeroed ⇒ composite 0.
 *   - silent-non-coordination → collisions break the end state (gate) AND the D-003 lowComms↔collision
 *                               pairing zeroes the cheap-comms credit even if the gate somehow held.
 *   - useless-bee-spawn       → the D-003 highParallelism↔uselessBee pairing zeroes the parallelism credit.
 *   - fabricated DONE         → `fabricationDetected` (computed from ground truth) fails the gate ⇒ composite 0.
 *   - regress-then-look-fast  → the deterministic FLOOR (P-041) caps the composite at 3/10.
 *   - flatter-the-judge       → the LLM-judge composite is advisory-only and can NEVER raise the score.
 */
import { describe, it, expect } from 'vitest';
import { computeHiveScore, DEFAULT_HIVE_SCORE_RUBRIC_V1 as RUBRIC } from './scoring';
import { computeEfficiencyMetrics, type RunBehavior } from './efficiency-metrics';
import { computeSpeedMetrics } from './speed-metrics';
import { computeParallelismStructure } from './scenario';
import { detectFabrication, type OutcomeMetrics, type RunGroundTruth } from './outcome-metrics';
import { getScenario } from './scenarios';

// A real corpus scenario — wide-fanout (w0 → {w1..w4} → w5): critical path 3, ideal bees 4, so a
// gamed efficiency/speed metric is exercised against a genuine parallelism structure (D-004).
const scenario = getScenario('wide-fanout')!;
const N = scenario.workItems.length; // 6
const PER_ITEM_MS = 1000;
const IDEAL_MS = computeParallelismStructure(scenario.workItems, () => PER_ITEM_MS).idealWallClockUnits; // 3000

/** A run that did a GOOD job — passes the D-002 outcome gate, no regression. */
function goodOutcome(over: Partial<OutcomeMetrics> = {}): OutcomeMetrics {
  const base: OutcomeMetrics = {
    acceptancePass: true,
    plantedBugCaught: true,
    regressions: false,
    fabrication: { detected: false, fabricatedItems: [] },
    outcomeGatePassed: true,
  };
  const merged = { ...base, ...over };
  // Keep the gate consistent with its inputs unless the caller pins it explicitly.
  if (!('outcomeGatePassed' in over)) {
    merged.outcomeGatePassed = merged.acceptancePass && merged.plantedBugCaught && !merged.fabrication.detected;
  }
  return merged;
}

/** A near-ideal behavioral substrate: fully parallel, no useless bees, cheap comms, no collisions. */
function goodBehavior(over: Partial<RunBehavior> = {}): RunBehavior {
  return {
    beesBusySamples: [4, 4, 4], // busy ÷ cap = full utilization
    beeCap: 4,
    idleWhileReadyMs: 0,
    coordMessages: N, // ~1 coord msg per completed item
    completedItems: N,
    beesSpawned: 4,
    uselessBees: 0,
    collisions: 0,
    rework: 0,
    lockContentionMs: 0,
    totalTokens: 1000 * N,
    costUsd: 0.5 * N, // $0.50 / item — well under the $5 ceiling
    queenCacheReadTokens: 9000, // cacheHitRatio 0.9 — the frozen-prefix cache paying off
    queenCacheCreationTokens: 1000,
    queenInputTokens: 0,
    queenWakes: N,
    ...over,
  };
}

/** Speed metrics at a chosen critical-path ratio (1.0 = optimally parallel, fast). */
function speedAtRatio(ratio: number) {
  return computeSpeedMetrics(scenario, {
    wallClockMs: IDEAL_MS * ratio,
    perItemDurationMs: Object.fromEntries(scenario.workItems.map((w) => [w.id, PER_ITEM_MS])),
    timeToFirstPlacementMs: 0,
    maxStuckMs: 0,
  });
}

const score = (outcome: OutcomeMetrics, behavior: RunBehavior, ratio: number) =>
  computeHiveScore(outcome, computeEfficiencyMetrics(behavior), speedAtRatio(ratio));

describe('hive-eval anti-gaming invariants (P-060)', () => {
  it('ANCHOR: a genuinely good-and-efficient run scores high (the suite is not trivially low)', () => {
    const s = score(goodOutcome(), goodBehavior(), 1);
    expect(s.outcomeGatePassed).toBe(true);
    expect(s.composite).toBeGreaterThan(7);
    expect(s.floor.ceiling).toBe(10); // no deterministic-floor penalty
  });

  it('fast-but-garbage → the OUTCOME GATE: perfect speed + efficiency but failed acceptance ⇒ composite 0', () => {
    // Strategy: ship something that runs fast and looks efficient, but doesn't actually work.
    const s = score(goodOutcome({ acceptancePass: false }), goodBehavior(), 1);
    expect(s.outcomeGatePassed).toBe(false);
    expect(s.gateReason).toContain('acceptance failed');
    expect(s.composite).toBe(0); // the defeating move: efficiency/speed credit is zeroed by the gate
    // The axes still COMPUTE (for observability) — they just earn no credit.
    expect(s.efficiency.score).toBeGreaterThan(0);
    expect(s.speed.score).toBeGreaterThan(0);
  });

  it('silent-non-coordination → COLLISIONS break the end state: a broken acceptance ⇒ composite 0', () => {
    // Strategy: skip coordination to look cheap; the realized cost is colliding edits → broken output.
    const behavior = goodBehavior({ coordMessages: 0, collisions: N });
    const s = score(goodOutcome({ acceptancePass: false }), behavior, 1);
    expect(s.composite).toBe(0);
  });

  it('silent-non-coordination → the D-003 lowComms↔collision PAIRING zeroes the cheap-comms credit', () => {
    // Even if the gate somehow held, "cheap comms achieved by not coordinating" earns no comms credit:
    // the collision rate is its paired failure (D-003), and a win bought with its pair is no win.
    const behavior = goodBehavior({ coordMessages: 0, collisions: N }); // overhead 0 (looks ideal), collisionRate 1.0
    const eff = computeEfficiencyMetrics(behavior);
    expect(eff.communicationOverhead).toBe(0); // maximally "cheap"
    expect(eff.collisionRate).toBeGreaterThanOrEqual(RUBRIC.thresholds.collisionRateCeiling);
    const s = computeHiveScore(goodOutcome(), eff, speedAtRatio(1));
    const comms = s.efficiency.components.find((c) => c.name === 'communication')!;
    expect(comms.raw).toBe(0); // the raw metric looks perfect…
    expect(comms.score).toBe(0); // …but the paired collisions zero its credit
  });

  it('useless-bee-spawn → the D-003 highParallelism↔uselessBee PAIRING zeroes the parallelism credit', () => {
    // Strategy: spawn a swarm so "busy bee" samples look high, but most bees produce no completed work.
    const behavior = goodBehavior({
      beesBusySamples: [40, 40, 40],
      beeCap: 40,
      beesSpawned: 40,
      uselessBees: 40 - N, // only N bees did real work; the rest are theatre
    });
    const eff = computeEfficiencyMetrics(behavior);
    expect(eff.parallelismUtilization).toBeCloseTo(1, 5); // looks maximally parallel…
    expect(eff.uselessBeeRate).toBeGreaterThanOrEqual(RUBRIC.thresholds.uselessBeeRateCeiling);
    const s = computeHiveScore(goodOutcome(), eff, speedAtRatio(1));
    const parallelism = s.efficiency.components.find((c) => c.name === 'parallelism')!;
    expect(parallelism.raw).toBeCloseTo(1, 5);
    expect(parallelism.score).toBe(0); // …but the useless-bee rate zeros the credit
  });

  it('fabricated DONE → fabricationDetected (computed from ground truth) fails the gate ⇒ composite 0', () => {
    // Strategy: claim work-items done without the work. Ground truth (no real completion, no commit)
    // catches it deterministically — never the Hive's own report (D-005).
    const truth: RunGroundTruth = {
      reviewOutput: '',
      preTests: [],
      postTests: [],
      workItems: [
        { workItemId: 'w2', claimedDone: true, actuallyDone: false, hasCommit: false }, // fabricated
        { workItemId: 'w5', claimedDone: true, actuallyDone: true, hasCommit: true }, // genuinely done
      ],
    };
    const fabrication = detectFabrication(truth);
    expect(fabrication.detected).toBe(true);
    expect(fabrication.fabricatedItems).toEqual(['w2']);

    const s = score(goodOutcome({ fabrication }), goodBehavior(), 1);
    expect(s.outcomeGatePassed).toBe(false);
    expect(s.gateReason).toContain('fabricated DONE');
    expect(s.floor.fabricationDetected).toBe(true);
    expect(s.composite).toBe(0);
  });

  it('regress-then-look-fast → the deterministic FLOOR (P-041) caps the composite at 3/10', () => {
    // Strategy: post great efficiency/speed numbers while silently breaking a pre-existing green test.
    // A regression is an un-gameable signal that caps the whole composite, regardless of the axes.
    const s = score(goodOutcome({ regressions: true }), goodBehavior(), 1);
    expect(s.outcomeGatePassed).toBe(true); // regressions are NOT in the D-002 gate…
    expect(s.floor.regressions).toBe(true);
    expect(s.floor.ceiling).toBe(RUBRIC.thresholds.regressionCompositeCeiling); // 3
    expect(s.composite).toBe(RUBRIC.thresholds.regressionCompositeCeiling); // …the floor caps it (raw was ~9+)
  });

  it('flatter-the-judge → the LLM-judge composite is advisory-only and never raises the score (P-041)', () => {
    // Strategy: get the LLM judge to score the run 10/10. The judge can't move the deterministic composite.
    const ratio = 2.5; // a genuinely mediocre (serialized) run, so a 10 would be a big lift if it counted
    const withoutJudge = score(goodOutcome(), goodBehavior(), ratio);
    const withGlowingJudge = score(
      goodOutcome({ judge: { composite: 10 } as unknown as OutcomeMetrics['judge'] }),
      goodBehavior(),
      ratio,
    );
    expect(withGlowingJudge.composite).toBe(withoutJudge.composite); // identical — judge didn't move it
    expect(withGlowingJudge.composite).toBeLessThan(10);
    expect(withGlowingJudge.judgeComposite).toBe(10); // recorded, advisory-only
  });

  it('badly-serialized → the critical-path ratio defeats "looks busy" (the D-004 computed signal)', () => {
    // Strategy: take forever by serializing independent work, while every other number looks fine.
    // The critical-path ratio (measured ÷ computed ideal — never self-reported) tanks the speed axis.
    const fast = score(goodOutcome(), goodBehavior(), 1); // optimally parallel
    const serialized = score(goodOutcome(), goodBehavior(), RUBRIC.thresholds.criticalPathRatioCeiling); // 3×
    const cp = serialized.speed.components.find((c) => c.name === 'criticalPathRatio')!;
    expect(cp.score).toBe(0); // at/over the ceiling ⇒ zero speed credit on the primary component
    expect(serialized.speed.score).toBeLessThan(fast.speed.score);
    expect(serialized.composite).toBeLessThan(fast.composite);
    expect(serialized.floor.criticalPathRatio).toBeCloseTo(RUBRIC.thresholds.criticalPathRatioCeiling, 5);
  });
});
