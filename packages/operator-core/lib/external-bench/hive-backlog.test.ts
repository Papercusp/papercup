/**
 * P-022 / redirect BRIEF 2 — the hive-over-backlog runner contract. Pins: (1) the canonical raw
 * record projects to the LOCKED P-025 `FleetRunSummary` (sums cost/tokens across the fleet,
 * parallel drain wall-clock, autonomy numerator); (2) the planner seam toggles hive ↔ queen-ablated
 * (the ONLY difference between the treatment + its headline baseline); (3) the runner port never
 * throws on a generation failure and is bound at the pilot.
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { planBatchPlacement } from '../fleet/batch-placement';
import { planFifoPlacement } from './queen-ablation';
import type { ArmAttempt } from './types';
import {
  runHiveBacklog,
  setHiveBacklogDriver,
  registerFleetPlanner,
  getFleetPlanner,
  toFleetRunSummary,
  HIVE_ARM,
  QUEEN_ABLATED_ARM,
  type FleetTaskResult,
  type HiveBacklogDriver,
  type HiveBacklogResult,
  type HiveBacklogRunRequest,
} from './hive-backlog';

afterEach(() => setHiveBacklogDriver(null));

// ── fixtures ─────────────────────────────────────────────────────────────────
function attempt(over: Partial<ArmAttempt> = {}): ArmAttempt {
  return {
    arm: 'hive',
    blueprintId: 'external-bench',
    instanceId: 'instance_x',
    seed: '0',
    diff: 'diff --git a b',
    tokensIn: 100_000,
    tokensOut: 20_000,
    costUsd: 3,
    turns: 10,
    wallClockMs: 60_000,
    trajectoryRef: 'rollout://traj/x',
    stopReason: 'done',
    ...over,
  };
}
function taskResult(over: Partial<FleetTaskResult> = {}): FleetTaskResult {
  return {
    attempt: attempt(),
    cupId: 'bee-1',
    placedAtMs: 1_000,
    startedAtMs: 1_100,
    finishedAtMs: 61_100,
    disposition: 'spawn',
    ...over,
  };
}
const REQ: HiveBacklogRunRequest = {
  arm: HIVE_ARM,
  suite: 'swe-bench-pro',
  runId: 'run-1',
  seed: 0,
  backlog: [],
  budget: { maxUsd: 100 },
};

// ── the planner seam (the hive ↔ queen-ablated toggle) ───────────────────────

test('the planner seam binds hive→planBatchPlacement and queen-ablated→planFifoPlacement (swap ONE function)', () => {
  assert.equal(getFleetPlanner(HIVE_ARM), planBatchPlacement); // the Queen's importance+affinity ranking
  assert.equal(getFleetPlanner(QUEEN_ABLATED_ARM), planFifoPlacement); // the naive FIFO ablation (136a4)
  // A competitor / external-orchestrator arm is NOT an our-fleet placement run → no planner.
  assert.equal(getFleetPlanner('openhands-async'), undefined);
});

test('registerFleetPlanner overrides an arm planner (an experimental Queen variant)', () => {
  const variant = planFifoPlacement; // stand-in
  registerFleetPlanner('hive-variant' as never, variant);
  assert.equal(getFleetPlanner('hive-variant' as never), variant);
});

// ── the FleetRunSummary projection (what P-025 consumes) ─────────────────────

test('toFleetRunSummary projects the raw record onto the LOCKED P-025 FleetRunSummary', () => {
  const result: HiveBacklogResult = {
    arm: HIVE_ARM,
    suite: 'swe-bench-pro',
    runId: 'run-1',
    seed: 2,
    startedAtMs: 1_000,
    finishedAtMs: 121_000, // 120s parallel drain window
    peakConcurrentBees: 3,
    coordEvents: [{ kind: 'placement', taskId: 'instance_a' }],
    taskResults: [
      taskResult({ attempt: attempt({ instanceId: 'a', costUsd: 3, tokensIn: 100_000, tokensOut: 20_000, stopReason: 'done', wallClockMs: 90_000 }) }),
      taskResult({ attempt: attempt({ instanceId: 'b', costUsd: 5, tokensIn: 150_000, tokensOut: 30_000, stopReason: 'done', wallClockMs: 110_000 }) }),
      taskResult({ attempt: attempt({ instanceId: 'c', costUsd: 2, tokensIn: 80_000, tokensOut: 10_000, stopReason: 'escalate', wallClockMs: 40_000 }) }),
    ],
  };
  const summary = toFleetRunSummary(result, /* resolvedCount (from grading) */ 2);
  assert.equal(summary.arm, 'hive');
  assert.equal(summary.runId, 'run-1');
  assert.equal(summary.suite, 'swe-bench-pro');
  assert.equal(summary.tasks, 3);
  assert.equal(summary.resolved, 2); // passed in from the external grader
  // wall-clock = the PARALLEL drain window (finished − started), NOT the Σ of per-task times.
  assert.equal(summary.wallClockMs, 120_000);
  // cost/tokens SUMMED across the whole fleet (coordination overhead counted).
  assert.equal(summary.costUsd, 10);
  assert.equal(summary.tokensTotal, 100_000 + 20_000 + 150_000 + 30_000 + 80_000 + 10_000);
  // autonomy numerator = tasks that reached DONE on their own (2 done, 1 escalate).
  assert.equal(summary.tasksZeroHumanGate, 2);
  assert.equal(summary.peakConcurrency, 3);
});

// ── the runner port (live driver bound at the pilot) ─────────────────────────

test('UNBOUND (no live driver) → runError result, empty taskResults, NEVER throws', async () => {
  const result = await runHiveBacklog(REQ);
  assert.equal(result.arm, 'hive');
  assert.equal(result.runId, 'run-1');
  assert.deepEqual(result.taskResults, []);
  assert.match(result.runError ?? '', /not bound/i);
});

test('a BOUND driver passes its result through', async () => {
  let seen: HiveBacklogRunRequest | null = null;
  const driver: HiveBacklogDriver = {
    async run(req) {
      seen = req;
      return {
        arm: req.arm,
        suite: req.suite,
        runId: req.runId,
        seed: req.seed,
        startedAtMs: 0,
        finishedAtMs: 100_000,
        peakConcurrentBees: 4,
        taskResults: [taskResult()],
        coordEvents: [],
      };
    },
  };
  setHiveBacklogDriver(driver);
  const result = await runHiveBacklog(REQ);
  assert.equal(seen!.arm, 'hive');
  assert.equal(result.peakConcurrentBees, 4);
  assert.equal(result.taskResults.length, 1);
  assert.equal(result.runError, undefined);
});

test('a driver that THROWS is captured as a runError result, not a thrown exception', async () => {
  setHiveBacklogDriver({
    async run() {
      throw new Error('hive boot failed');
    },
  });
  const result = await runHiveBacklog(REQ);
  assert.match(result.runError ?? '', /hive boot failed/);
  assert.deepEqual(result.taskResults, []);
});
