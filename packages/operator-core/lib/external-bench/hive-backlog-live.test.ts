/**
 * P-022 pilot-prep — the live hive-backlog driver ORCHESTRATION (the scripted boot→enroll→place→
 * drain→collect→teardown loop). Verified over a FAKE ops seam + a FAKE planner (no git/PG/LLM), so
 * the loop wiring 136a4's queen-ablated arm plugs into (via getFleetPlanner) is green before the
 * gated real run. The real fleet-ops binding is verified at the owner trigger (P-032).
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { liveHiveBacklogDriver, type EnrolledTask, type HiveBacklogOps } from './hive-backlog-live';
import { registerFleetPlanner, setHiveBacklogDriver, type FleetTaskResult, type HiveBacklogRunRequest } from './hive-backlog';
import type { BatchPlacementInput, BatchPlacementPlan } from '../fleet/batch-placement';
import type { ArmAttempt, BenchTask } from './types';

afterEach(() => setHiveBacklogDriver(null));

const TEST_ARM = 'test-hive';
const TASKS: BenchTask[] = [
  { benchmark: 'swe-bench-pro', instanceId: 'a', problemStatement: 'fix a', graderMeta: {} },
  { benchmark: 'swe-bench-pro', instanceId: 'b', problemStatement: 'fix b', graderMeta: {} },
];
const REQ: HiveBacklogRunRequest = {
  arm: TEST_ARM,
  suite: 'swe-bench-pro',
  runId: 'run-1',
  seed: 0,
  backlog: TASKS,
  budget: { maxUsd: 50 },
};

/** A fake planner that fresh-spawns every frontier task (avoids coupling to planBatchPlacement internals). */
const fakeSpawnPlanner = (input: BatchPlacementInput): BatchPlacementPlan => ({
  decisions: input.tasks.map((task) => ({ task, disposition: 'spawn' as const, reason: 'fake spawn' })),
  spawnCount: input.tasks.length,
  injectCount: 0,
  unplacedCount: 0,
  projectedLoad: {},
  remainingHeadroom: input.headroom,
});
registerFleetPlanner(TEST_ARM, fakeSpawnPlanner);

function fakeAttempt(instanceId: string, arm: string): ArmAttempt {
  return {
    arm, blueprintId: 'external-bench', instanceId, seed: '0', diff: `diff ${instanceId}`,
    tokensIn: 100_000, tokensOut: 20_000, costUsd: 3, turns: 8, wallClockMs: 60_000,
    trajectoryRef: `rollout://${instanceId}`, stopReason: 'done',
  };
}

interface Calls { enrolled: string[]; placed: string[]; paused: number; torn: number; collected: string[]; }

function fakeOps(over: Partial<HiveBacklogOps> = {}): { ops: HiveBacklogOps; calls: Calls } {
  const calls: Calls = { enrolled: [], placed: [], paused: 0, torn: 0, collected: [] };
  let polls = 0;
  const base: HiveBacklogOps = {
    now: () => 1_000 + polls,
    sleep: async () => { polls++; },
    createHive: async () => ({ hiveHome: 'xb-hive' }),
    enrollTask: async ({ task }) => {
      const e: EnrolledTask = { task, member: `m-${task.instanceId}`, clonePath: `/c/${task.instanceId}`, workItemId: `WI-${task.instanceId}` };
      calls.enrolled.push(task.instanceId);
      return e;
    },
    // frontier is full on the first poll, empty after (the tasks get placed + run).
    gatherFrontier: async () =>
      (polls === 0
        ? TASKS.map((t) => ({ id: t.instanceId, harness: 'm', title: t.instanceId }))
        : []) as unknown as BatchPlacementInput['tasks'],
    gatherBees: async () => ({ bees: [] as unknown as BatchPlacementInput['bees'], headroom: 2 }),
    placeBatch: async ({ plan }) => {
      const placements = plan.decisions.map((d) => ({
        instanceId: (d.task as unknown as { id: string }).id,
        beeId: `bee-${(d.task as unknown as { id: string }).id}`,
        disposition: 'spawn' as const,
      }));
      calls.placed.push(...placements.map((p) => p.instanceId));
      return { placements };
    },
    countInFlight: async () => (polls < 2 ? 1 : 0), // drained after 2 polls
    pauseFleet: async () => { calls.paused++; },
    collectTask: async ({ enrolled, arm }): Promise<FleetTaskResult> => {
      calls.collected.push(enrolled.task.instanceId);
      return { attempt: fakeAttempt(enrolled.task.instanceId, arm), beeId: `bee-${enrolled.task.instanceId}`, placedAtMs: 1, startedAtMs: 2, finishedAtMs: 3, disposition: 'spawn' };
    },
    teardown: async () => { calls.torn++; },
  };
  return { ops: { ...base, ...over }, calls };
}

test('the orchestration enrolls the backlog, places via the arm planner, drains, collects, tears down', async () => {
  const { ops, calls } = fakeOps();
  const driver = liveHiveBacklogDriver(ops, { workspaceId: 'ws-1', pollIntervalMs: 1, fleetTimeoutMs: 10_000 });
  const result = await driver.run(REQ);

  assert.equal(result.runError, undefined);
  assert.equal(result.arm, TEST_ARM);
  assert.deepEqual(calls.enrolled, ['a', 'b']); // whole backlog enrolled
  assert.deepEqual(calls.placed, ['a', 'b']); // both placed via the planner
  assert.deepEqual(calls.collected, ['a', 'b']); // per-task leaves collected
  assert.equal(result.taskResults.length, 2);
  assert.ok(calls.paused >= 1, 'fleet paused to bound spend');
  assert.equal(calls.torn, 1, 'hive torn down');
  // coordEvents: 2 enroll claims + 2 placements.
  assert.equal(result.coordEvents.filter((e) => e.kind === 'placement').length, 2);
  assert.equal(result.coordEvents.filter((e) => e.kind === 'claim').length, 2);
  assert.ok(result.finishedAtMs >= result.startedAtMs);
});

test('an arm with NO registered planner → runError, no hive created (not an our-fleet run)', async () => {
  const { ops, calls } = fakeOps();
  const driver = liveHiveBacklogDriver(ops, { workspaceId: 'ws-1' });
  const result = await driver.run({ ...REQ, arm: 'openhands-async' });
  assert.match(result.runError ?? '', /no fleet placement planner/i);
  assert.equal(calls.enrolled.length, 0);
});

test('an ops failure mid-run → runError, fleet paused + torn down, NEVER throws', async () => {
  const { ops, calls } = fakeOps({
    enrollTask: async () => { throw new Error('clone @ base failed'); },
  });
  const driver = liveHiveBacklogDriver(ops, { workspaceId: 'ws-1', pollIntervalMs: 1 });
  const result = await driver.run(REQ);
  assert.match(result.runError ?? '', /clone @ base failed/);
  assert.ok(calls.paused >= 1);
  assert.equal(calls.torn, 1);
});
