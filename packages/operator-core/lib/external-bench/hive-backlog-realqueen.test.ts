/**
 * P-033 — the REAL-Queen-vs-no-Queen backlog driver. The pure, NO-spend slices: the hive_placements
 * → CoordEvent reconstruction (the real-Queen coordination trace the FIFO arm can't produce) and the
 * driver ORCHESTRATION over INJECTED fake ops (proves real-Queen wakes the Queen + polls-until-drained;
 * proves FIFO never starts the Queen + runs the scripted loop). NO real hive, NO bee spawn, NO LLM.
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  realQueenBacklogDriver,
  bindRealQueenBacklogDriver,
  buildRealQueenCoordEvents,
  HIVE_REALQUEEN_ARM,
  FIFO_NOQUEEN_ARM,
  type RealQueenBacklogOps,
  type RealQueenEnrolled,
  type HivePlacementRow,
} from './hive-backlog-realqueen';
import {
  runHiveBacklog,
  setHiveBacklogDriver,
  registerFleetPlanner,
  type HiveBacklogRunRequest,
} from './hive-backlog';
import { planFifoPlacement } from './queen-ablation';
import type { BenchTask } from './types';

afterEach(() => setHiveBacklogDriver(null));

function task(n: number): BenchTask {
  return {
    benchmark: 'swe-bench-pro',
    instanceId: `instance_smoke__task-${n}`,
    problemStatement: `synthetic task ${n}`,
    repo: 'acme/widgets',
    baseCommit: `base${n}`,
    graderMeta: { dockerhub_tag: `tag-${n}` },
  };
}

function enrolled(t: BenchTask): RealQueenEnrolled {
  return {
    task: t,
    member: `m-${t.instanceId}`,
    clonePath: `/tmp/${t.instanceId}`,
    workItemId: `F-${t.instanceId.toUpperCase().replace(/[^A-Z0-9]/g, '')}`,
    checkout: { dir: `/tmp/${t.instanceId}`, repo: t.repo!, baseCommit: t.baseCommit!, cleanup: async () => {} },
    beeId: null,
    placedAtMs: null,
    disposition: null,
  };
}

// ── the hive_placements → CoordEvent reconstruction (pure) ───────────────────

test('buildRealQueenCoordEvents maps placements + re-placements + stranded from the ledger', () => {
  const f2i = new Map([['F-A', 'instance_a'], ['F-B', 'instance_b'], ['F-C', 'instance_c']]);
  const rows: HivePlacementRow[] = [
    { work_item_id: 'F-A', harness_slug: 'm-a', bee_spawn_id: 's-1', status: 'completed', fail_count: 0, last_disposition: 'completed', placed_at: new Date(1000) },
    { work_item_id: 'F-B', harness_slug: 'm-b', bee_spawn_id: 's-2', status: 'working', fail_count: 2, last_disposition: 'recover', placed_at: new Date(2000) },
    { work_item_id: 'F-C', harness_slug: 'm-c', bee_spawn_id: null, status: 'stranded', fail_count: 3, last_disposition: 'stranded', placed_at: new Date(3000) },
  ];
  const ev = buildRealQueenCoordEvents(rows, f2i);
  // A: placement + complete. B: placement + rework (re-placed). C: placement + rework + stranded_item.
  const kinds = ev.map((e) => e.kind);
  assert.ok(kinds.includes('placement'));
  assert.ok(kinds.includes('complete'), 'completed row → complete event');
  assert.ok(kinds.includes('rework'), 'fail_count>0 / recover → rework (the Queen re-placed — FIFO cannot)');
  assert.ok(kinds.includes('stranded_item'), 'stranded status → coordination-breakdown signal');
  // taskId mapped back to the real instanceId, not the feature id.
  assert.equal(ev[0].taskId, 'instance_a');
  // Exactly one placement per ledger row.
  assert.equal(ev.filter((e) => e.kind === 'placement').length, 3);
});

test('buildRealQueenCoordEvents on a clean run (no fails) yields placements + completes only — no MAST signals', () => {
  const f2i = new Map([['F-A', 'instance_a'], ['F-B', 'instance_b']]);
  const rows: HivePlacementRow[] = [
    { work_item_id: 'F-A', harness_slug: 'm-a', bee_spawn_id: 's-1', status: 'completed', fail_count: 0, last_disposition: 'completed', placed_at: new Date(1) },
    { work_item_id: 'F-B', harness_slug: 'm-b', bee_spawn_id: 's-2', status: 'completed', fail_count: 0, last_disposition: 'completed', placed_at: new Date(2) },
  ];
  const ev = buildRealQueenCoordEvents(rows, f2i);
  assert.equal(ev.filter((e) => e.kind === 'rework').length, 0);
  assert.equal(ev.filter((e) => e.kind === 'stranded_item').length, 0);
  assert.equal(ev.filter((e) => e.kind === 'placement').length, 2);
});

// ── the driver ORCHESTRATION over fakes ──────────────────────────────────────

/** A fake ops that records the call sequence + lets the test settle the drain after one poll. */
function fakeOps(record: string[], opts: { realQueenStarted?: () => void } = {}): RealQueenBacklogOps {
  let polls = 0;
  const enrolledMembers: RealQueenEnrolled[] = [];
  return {
    now: () => polls * 1000,
    sleep: async () => { polls++; },
    async createHive() { record.push('createHive'); return { hiveHome: 'xbq-fake' }; },
    async enrollTask({ task: t }) { record.push(`enroll:${t.instanceId}`); const e = enrolled(t); enrolledMembers.push(e); return e; },
    async startRealQueen() { record.push('startRealQueen'); opts.realQueenStarted?.(); },
    async rewakeQueen() { record.push('rewakeQueen'); },
    async reconcileWatchdog() { record.push('reconcileWatchdog'); },
    async survey() { record.push('survey'); return { frontierLen: polls === 0 ? 1 : 0, plansLen: 0 }; },
    async countInFlight() { record.push('countInFlight'); return polls === 0 ? 1 : 0; },
    async countLiveBees() { return polls === 0 ? 2 : 0; },
    async gatherForFifo({ members }) {
      record.push('gatherForFifo');
      const unplaced = members.filter((m) => m.beeId == null);
      return {
        tasks: (polls === 0 ? unplaced.map((m) => ({ id: m.workItemId, importance: 'normal' })) : []) as never,
        bees: [] as never,
        headroom: 5,
      };
    },
    async placeFifoBatch({ plan, members }) {
      record.push('placeFifoBatch');
      // Mark every spawn decision as placed so the next poll drains.
      const placements = plan.decisions
        .filter((d) => d.disposition === 'spawn')
        .map((d, i) => {
          const m = members[i];
          return { instanceId: m.task.instanceId, beeId: `s-${i}`, disposition: 'spawn' as const };
        });
      return { placements };
    },
    async pauseFleet() { record.push('pauseFleet'); },
    async collectTask({ enrolled: e, arm, seed }) {
      return {
        attempt: {
          arm, blueprintId: 'external-bench', instanceId: e.task.instanceId, seed,
          diff: 'diff --git a b', tokensIn: 1, tokensOut: 1, costUsd: 0.1, turns: 1, wallClockMs: 1,
          trajectoryRef: 'x', stopReason: 'done',
        },
        beeId: e.beeId ?? 's-x', placedAtMs: 0, startedAtMs: 0, finishedAtMs: 1, disposition: 'spawn',
      };
    },
    async collectCoordEvents({ arm }) {
      record.push('collectCoordEvents');
      return arm === HIVE_REALQUEEN_ARM ? [{ kind: 'placement', taskId: 'instance_smoke__task-0', detail: 'real' }] : [];
    },
    async teardown() { record.push('teardown'); },
  };
}

test('real-Queen arm: starts the Queen, polls until drained, uses the hive_placements coord trace', async () => {
  let queenStarted = false;
  const record: string[] = [];
  const ops = fakeOps(record, { realQueenStarted: () => { queenStarted = true; } });
  const driver = realQueenBacklogDriver(ops, { workspaceId: 'ws', pollIntervalMs: 0, fleetTimeoutMs: 60_000 });
  const req: HiveBacklogRunRequest = {
    arm: HIVE_REALQUEEN_ARM, suite: 'swe-bench-pro', runId: 'r1', seed: 1, backlog: [task(0)], budget: { maxUsd: 1 },
  };
  const res = await driver.run(req);
  assert.ok(queenStarted, 'the real Queen agent was started (startHive)');
  assert.ok(record.includes('startRealQueen'), 'startRealQueen called');
  assert.ok(!record.includes('gatherForFifo'), 'real-Queen arm NEVER runs the FIFO scripted loop');
  assert.ok(!record.includes('placeFifoBatch'), 'real-Queen arm NEVER places — the Queen does');
  assert.ok(record.includes('reconcileWatchdog'), 'real-Queen arm fires the placement-watchdog sweep (eviction/re-placement)');
  assert.equal(res.runError, undefined);
  assert.equal(res.taskResults.length, 1);
  assert.equal(res.coordEvents[0]?.detail, 'real', 'used the hive_placements-derived (real) coord trace');
  assert.ok(res.peakConcurrentBees >= 2, 'peak bees sampled every poll (the fixed counter)');
});

test('real-Queen arm: RE-WAKES the Queen when the frontier is ready but no bee is live (the :3170 nudge)', async () => {
  // Fake: poll 0 → frontier ready (1), NO live bee, nothing in flight → the driver must re-wake her.
  //       poll 1 → drained. Mirrors a Queen whose first session exited without placing.
  const record: string[] = [];
  let polls = 0;
  const base = fakeOps(record);
  const ops: RealQueenBacklogOps = {
    ...base,
    now: () => polls * 1000,
    sleep: async () => { polls++; },
    async survey() { record.push('survey'); return { frontierLen: polls === 0 ? 1 : 0, plansLen: 0 }; },
    async countInFlight() { return 0; },
    async countLiveBees() { return 0; }, // no bee ever live → the re-wake trigger
  };
  const driver = realQueenBacklogDriver(ops, { workspaceId: 'ws', pollIntervalMs: 0, fleetTimeoutMs: 60_000 });
  const res = await driver.run({
    arm: HIVE_REALQUEEN_ARM, suite: 'swe-bench-pro', runId: 'rw', seed: 1, backlog: [task(0)], budget: { maxUsd: 1 },
  });
  assert.ok(record.includes('rewakeQueen'), 'a ready-but-unplaced frontier with no live bee re-wakes the Queen');
  assert.equal(res.runError, undefined);
});

test('real-Queen arm: does NOT re-wake while bees are live (she is already working)', async () => {
  const record: string[] = [];
  let polls = 0;
  const base = fakeOps(record);
  const ops: RealQueenBacklogOps = {
    ...base,
    now: () => polls * 1000,
    sleep: async () => { polls++; },
    async survey() { record.push('survey'); return { frontierLen: polls === 0 ? 1 : 0, plansLen: 0 }; },
    async countInFlight() { return polls === 0 ? 1 : 0; },
    async countLiveBees() { return polls === 0 ? 2 : 0; }, // bees live → NO re-wake
  };
  const driver = realQueenBacklogDriver(ops, { workspaceId: 'ws', pollIntervalMs: 0, fleetTimeoutMs: 60_000 });
  await driver.run({
    arm: HIVE_REALQUEEN_ARM, suite: 'swe-bench-pro', runId: 'rw2', seed: 1, backlog: [task(0)], budget: { maxUsd: 1 },
  });
  assert.ok(!record.includes('rewakeQueen'), 'live bees in flight ⇒ the Queen is working ⇒ no re-wake');
});

test('FIFO no-Queen arm: NEVER starts the Queen, runs the scripted FIFO loop', async () => {
  let queenStarted = false;
  const record: string[] = [];
  registerFleetPlanner(FIFO_NOQUEEN_ARM, planFifoPlacement);
  const ops = fakeOps(record, { realQueenStarted: () => { queenStarted = true; } });
  const driver = realQueenBacklogDriver(ops, { workspaceId: 'ws', pollIntervalMs: 0, fleetTimeoutMs: 60_000 });
  const req: HiveBacklogRunRequest = {
    arm: FIFO_NOQUEEN_ARM, suite: 'swe-bench-pro', runId: 'r2', seed: 1, backlog: [task(0)], budget: { maxUsd: 1 },
  };
  const res = await driver.run(req);
  assert.ok(!queenStarted, 'the Queen is NEVER started in the no-Queen arm');
  assert.ok(!record.includes('startRealQueen'), 'startRealQueen NOT called');
  assert.ok(record.includes('gatherForFifo'), 'FIFO arm runs the scripted gather→plan loop');
  assert.ok(record.includes('placeFifoBatch'), 'FIFO arm places via the scripted loop');
  assert.ok(!record.includes('reconcileWatchdog'), 'FIFO arm does NOT run the watchdog — no eviction/re-placement (the ablation)');
  assert.equal(res.runError, undefined);
  assert.equal(res.taskResults.length, 1);
});

test('FIFO arm errors loudly when no planner is registered for its arm', async () => {
  const record: string[] = [];
  const ops = fakeOps(record);
  const driver = realQueenBacklogDriver(ops, { workspaceId: 'ws', pollIntervalMs: 0 });
  // 'fifo-unregistered' has no planner.
  const res = await driver.run({ arm: 'fifo-unregistered', suite: 'swe-bench-pro', runId: 'r3', seed: 1, backlog: [task(0)], budget: {} });
  assert.match(res.runError ?? '', /no FIFO placement planner/);
});

test('bindRealQueenBacklogDriver wires runHiveBacklog (over injected fake ops)', async () => {
  const record: string[] = [];
  registerFleetPlanner(FIFO_NOQUEEN_ARM, planFifoPlacement);
  bindRealQueenBacklogDriver({ workspaceId: 'ws', pollIntervalMs: 0 }, fakeOps(record));
  const res = await runHiveBacklog({ arm: FIFO_NOQUEEN_ARM, suite: 'swe-bench-pro', runId: 'r4', seed: 1, backlog: [task(0)], budget: {} });
  assert.equal(res.arm, FIFO_NOQUEEN_ARM);
  assert.ok(record.includes('createHive'), 'the bound driver ran via runHiveBacklog');
});
