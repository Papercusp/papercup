/**
 * Pilot SMOKE for the Queen-ablation arm (P-023 / BRIEF 4) — the contract-projection smoke.
 *
 * ⚠ SYNTHETIC FIXTURES, NOT a benchmark run. This proves the queen-ablated arm flows END-TO-END
 * into the LOCKED bench-metrics fleet contract — the REAL `planFifoPlacement` decides placements →
 * a {@link HiveBacklogResult} → {@link toFleetRunSummary} → `buildHiveReport` → a well-formed
 * `queenDelta` (hive vs queen-ablated). It de-risks the real bounded run (catches any
 * FleetRunSummary/buildHiveReport mismatch BEFORE the live driver + Docker grader land), without
 * spending a cent. The actual hive−ablated numbers come ONLY from the owner-gated live run
 * (1226c's live `HiveBacklogDriver` + ec8fe's SWE-bench-Pro grader + real fleet budget) — the
 * numbers asserted here are illustrative plumbing values, never reported as a finding.
 */
import { describe, it, expect } from 'vitest';
import { buildHiveReport, type CoordEvent, type FleetRunSummary } from '@papercusp/bench-metrics';
import type { PlacementBee, PlacementTask } from '../fleet/placement-affinity';
import {
  HIVE_ARM,
  QUEEN_ABLATED_ARM,
  getFleetPlanner,
  toFleetRunSummary,
  type FleetTaskResult,
  type HiveBacklogResult,
} from './hive-backlog';
import { planFifoPlacement, FIFO_POLICY } from './queen-ablation';
import type { ArmAttempt, BenchTask } from './types';

const SUITE = 'swe-bench-pro' as const;
const RUN_ID = 'smoke-run-0001';

function benchTask(n: number): BenchTask {
  return {
    benchmark: 'swe-bench-pro',
    instanceId: `instance_smoke__task-${n}`,
    problemStatement: `synthetic task ${n}`,
    repo: 'acme/widgets',
    baseCommit: `base${n}`,
    graderMeta: { dockerhub_tag: `tag-${n}` },
  };
}

/** A synthetic per-task generation result (a single bee's external-bench leaf). */
function synthAttempt(task: BenchTask, resolved: boolean): ArmAttempt {
  return {
    arm: QUEEN_ABLATED_ARM,
    blueprintId: 'external-bench', // fleet bees run the FULL spine — the QUEEN is ablated, not the spine
    instanceId: task.instanceId,
    seed: '1',
    diff: resolved ? `diff --git a/fix${task.instanceId} b/fix` : '',
    tokensIn: 1000,
    tokensOut: 500,
    costUsd: 0.05,
    turns: 6,
    wallClockMs: 60_000,
    trajectoryRef: `traj://${task.instanceId}`,
    stopReason: 'done',
  };
}

/**
 * Drive the REAL planner for an arm over a synthetic backlog, then synthesize the fleet run record.
 * The placements come from `getFleetPlanner(arm)` (planFifoPlacement for queen-ablated) — that's the
 * part under test; the task OUTCOMES + timings are synthetic plumbing.
 */
function synthHiveResult(
  arm: typeof HIVE_ARM | typeof QUEEN_ABLATED_ARM,
  backlog: BenchTask[],
  opts: { wallClockMs: number; resolvedCount: number; coordEvents?: CoordEvent[] },
): HiveBacklogResult {
  const planner = getFleetPlanner(arm)!;
  // One free slot per task → the planner fills the pool (all 'spawn'); exercises the real fn.
  const tasksAsPlacement: PlacementTask[] = backlog.map((t) => ({ id: t.instanceId, harness: 'bench', title: t.instanceId }));
  const bees: PlacementBee[] = [];
  const plan = planner({ tasks: tasksAsPlacement, bees, headroom: backlog.length });

  const taskResults: FleetTaskResult[] = backlog.map((task, i) => {
    const decision = plan.decisions[i];
    return {
      attempt: synthAttempt(task, i < opts.resolvedCount),
      cupId: `bee-${i}`,
      placedAtMs: 1000,
      startedAtMs: 1000,
      finishedAtMs: 1000 + 60_000,
      disposition: decision?.disposition === 'warm-inject' ? 'warm-inject' : 'spawn',
    };
  });

  return {
    arm,
    suite: SUITE,
    runId: RUN_ID,
    seed: 1,
    startedAtMs: 0,
    finishedAtMs: opts.wallClockMs,
    peakConcurrentBees: backlog.length,
    taskResults,
    coordEvents: opts.coordEvents ?? [],
  };
}

describe('queen-ablated pilot smoke — end-to-end into the locked fleet contract (SYNTHETIC)', () => {
  const backlog = [benchTask(1), benchTask(2), benchTask(3)];

  it('the queen-ablated arm is driven by planFifoPlacement (the FIFO ablation, not the Queen)', () => {
    expect(getFleetPlanner(QUEEN_ABLATED_ARM)).toBe(planFifoPlacement);
    expect(FIFO_POLICY).toBe('fifo'); // recorded in arm_meta.placement_policy
  });

  it('projects planFifoPlacement → HiveBacklogResult → FleetRunSummary cleanly', () => {
    const result = synthHiveResult(QUEEN_ABLATED_ARM, backlog, { wallClockMs: 200_000, resolvedCount: 2 });
    expect(result.taskResults).toHaveLength(3);
    // every placement came from the real FIFO planner (pool-fill → all 'spawn' on an empty fleet)
    expect(result.taskResults.every((t) => t.disposition === 'spawn')).toBe(true);

    const summary = toFleetRunSummary(result, /* resolvedCount from grading */ 2);
    expect(summary.arm).toBe('queen-ablated');
    expect(summary.tasks).toBe(3);
    expect(summary.resolved).toBe(2);
    expect(summary.costUsd).toBeCloseTo(0.15); // 3 × 0.05 — coordination overhead summed
    expect(summary.wallClockMs).toBe(200_000); // PARALLEL drain window, not Σ per-task
    expect(summary.tasksZeroHumanGate).toBe(3); // all reached DONE (no human gate on a benchmark)
  });

  it('feeds buildHiveReport alongside hive + serial → a well-formed queenDelta + MAST rates', () => {
    // SYNTHETIC: identical resolved counts (same grader + per-task unit); only wall-clock differs to
    // exercise the throughput/speedup ratio math. NOT a finding — the real delta is the gated run.
    const serial: FleetRunSummary = {
      runId: RUN_ID, suite: SUITE, arm: 'native-serial', tasks: 3, resolved: 2,
      wallClockMs: 600_000, costUsd: 0.15, tokensTotal: 4500, tasksZeroHumanGate: 3, peakConcurrency: 1,
    };
    const hiveResult = synthHiveResult(HIVE_ARM, backlog, { wallClockMs: 150_000, resolvedCount: 2 });
    const ablatedResult = synthHiveResult(QUEEN_ABLATED_ARM, backlog, { wallClockMs: 200_000, resolvedCount: 2 });

    // a mechanical MAST signal in the ablated trace (FIFO has no dedup intelligence) vs a clean hive trace
    const ablatedTrace: CoordEvent[] = [
      { kind: 'placement', taskId: 'instance_smoke__task-1' },
      { kind: 'duplicate_completion', taskId: 'instance_smoke__task-2', detail: 'two bees finished the same task' },
    ];
    const hiveTrace: CoordEvent[] = [{ kind: 'placement', taskId: 'instance_smoke__task-1' }];

    const report = buildHiveReport(
      [
        { summary: toFleetRunSummary(hiveResult, 2), coordEvents: hiveTrace },
        { summary: toFleetRunSummary(ablatedResult, 2), coordEvents: ablatedTrace },
        { summary: serial },
      ],
      { serialArm: 'native-serial' },
    );

    expect(report.arms.map((a) => a.arm).sort()).toEqual(['hive', 'native-serial', 'queen-ablated']);
    expect(report.queenDelta).not.toBeNull();
    const d = report.queenDelta!;
    expect(d.treatment).toBe('hive');
    expect(d.baseline).toBe('queen-ablated');
    expect(Number.isFinite(d.throughputRatio!)).toBe(true); // hive resolved/hr ÷ ablated resolved/hr
    expect(Number.isFinite(d.costRatio!)).toBe(true);
    // the ablated arm's objective MAST substrate rate is computed from its trace (1 dup over 3 tasks)
    const ablated = report.arms.find((a) => a.arm === 'queen-ablated')!;
    expect(ablated.mast?.substrate?.duplicationRate).toBeCloseTo(1 / 3);
    // hive coordinates better here (no dup) → coordFailureRateDelta negative or zero
    expect(d.coordFailureRateDelta).not.toBeNull();
    expect(d.coordFailureRateDelta!).toBeLessThanOrEqual(0);

    // speedup vs the serial floor is computed for both fleet arms
    const ablatedThru = report.arms.find((a) => a.arm === 'queen-ablated')!.throughput;
    expect(ablatedThru.speedupVsSerial).toBeCloseTo(600_000 / 200_000); // 3×
  });
});
