/**
 * P-001 (benchmark-arms-su-vs-queen-expansion-2026-06-16) — the su-independent backlog driver. The
 * pure, NO-spend slices over INJECTED fake ops: proves boot→spawn→collect→teardown ordering, the
 * concurrency pool respects the fleet cap (≤cap agents live at once), the live-concurrency timeline
 * (peak/avg/samples) is populated, and the never-throw generation-failure contract. NO real git,
 * NO PG, NO LLM, NO live spawns — every side effect is a fake. Mirrors hive-backlog-realqueen.test.ts.
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  suIndependentBacklogDriver,
  bindSuIndependentBacklogDriver,
  SU_INDEPENDENT_ARM,
  type SuIndependentBacklogOps,
  type SuIndependentEnrolled,
  type SuTaskOutcome,
} from './su-independent-backlog';
import { runHiveBacklog, setHiveBacklogDriver, type HiveBacklogRunRequest } from './hive-backlog';
import type { BenchTask, GenerationTelemetry } from './types';

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

function backlog(n: number): BenchTask[] {
  return Array.from({ length: n }, (_, i) => task(i));
}

function telemetry(over: Partial<GenerationTelemetry> = {}): GenerationTelemetry {
  return {
    tokensIn: 10,
    tokensOut: 20,
    costUsd: 0.5,
    turns: 3,
    wallClockMs: 100,
    trajectoryRef: 'xbench://slug-x',
    stopReason: 'done',
    ...over,
  };
}

interface FakeOpts {
  cap?: number;
  /** Hook to observe/record live concurrency at each task's run start (for the pool-cap assertion). */
  onRun?: (peakSeen: number) => void;
  /** Tasks whose runOneTask should throw (infra failure path). */
  throwOnRun?: Set<string>;
  /** Tasks whose prepareTask should throw (clone failure path). */
  throwOnPrepare?: Set<string>;
}

/**
 * A fake ops that records the call sequence + tracks live concurrency itself (so the test can assert
 * the pool never exceeds the cap). `runOneTask` resolves on the next microtask so multiple tasks are
 * genuinely in flight concurrently under Promise.all.
 */
function fakeOps(record: string[], o: FakeOpts = {}): { ops: SuIndependentBacklogOps; maxLive: () => number } {
  const cap = o.cap ?? 3;
  let live = 0;
  let maxLive = 0;
  const ops: SuIndependentBacklogOps = {
    now: () => Date.now(),
    concurrencyCap: () => cap,
    async prepareTask({ task: t }) {
      record.push(`prepare:${t.instanceId}`);
      if (o.throwOnPrepare?.has(t.instanceId)) throw new Error(`clone boom ${t.instanceId}`);
      const enrolled: SuIndependentEnrolled = {
        task: t,
        clonePath: `/tmp/${t.instanceId}`,
        checkout: { dir: `/tmp/${t.instanceId}`, repo: t.repo!, baseCommit: t.baseCommit!, cleanup: async () => {} },
        agentId: null,
        startedAtMs: null,
        finishedAtMs: null,
      };
      return enrolled;
    },
    async runOneTask({ enrolled }): Promise<SuTaskOutcome> {
      live += 1;
      if (live > maxLive) maxLive = live;
      o.onRun?.(maxLive);
      record.push(`run:${enrolled.task.instanceId}`);
      // Yield so sibling pool workers actually overlap (genuine concurrency under Promise.all).
      await Promise.resolve();
      await Promise.resolve();
      try {
        if (o.throwOnRun?.has(enrolled.task.instanceId)) throw new Error(`run boom ${enrolled.task.instanceId}`);
        return {
          diff: `diff --git a/${enrolled.task.instanceId} b`,
          telemetry: telemetry(),
          agentId: `agent-${enrolled.task.instanceId}`,
        };
      } finally {
        live -= 1;
      }
    },
    async teardownTask({ enrolled }) {
      record.push(`teardown:${enrolled.task.instanceId}`);
    },
  };
  return { ops, maxLive: () => maxLive };
}

function req(over: Partial<HiveBacklogRunRequest> = {}): HiveBacklogRunRequest {
  return {
    arm: SU_INDEPENDENT_ARM,
    suite: 'swe-bench-pro',
    runId: 'r1',
    seed: 1,
    backlog: backlog(1),
    budget: { maxUsd: 1 },
    ...over,
  };
}

// ── boot → spawn → collect → teardown ─────────────────────────────────────────

test('su-independent: prepares, runs ONE independent agent per task, tears it down, NO coord trace', async () => {
  const record: string[] = [];
  const { ops } = fakeOps(record, { cap: 3 });
  const driver = suIndependentBacklogDriver(ops, { workspaceId: 'ws', sampleIntervalMs: 1 });
  const res = await driver.run(req({ backlog: backlog(2) }));

  assert.equal(res.runError, undefined, 'a clean run carries no runError');
  assert.equal(res.taskResults.length, 2, 'one result per backlog task');
  // Every task went prepare → run → teardown (ordering per task).
  for (const i of [0, 1]) {
    const id = `instance_smoke__task-${i}`;
    const prep = record.indexOf(`prepare:${id}`);
    const run = record.indexOf(`run:${id}`);
    const td = record.indexOf(`teardown:${id}`);
    assert.ok(prep >= 0 && run > prep && td > run, `prepare→run→teardown ordering for ${id}`);
  }
  // An independent-agent arm produces NO coordination trace — that is the whole point.
  assert.equal(res.coordEvents.length, 0, 'su-independent emits NO coordEvents (no queen/hive)');
  // The per-task result maps the spine-drive outcome through to a FleetTaskResult / ArmAttempt.
  const a = res.taskResults[0].attempt;
  assert.equal(a.arm, SU_INDEPENDENT_ARM);
  assert.equal(a.blueprintId, 'external-bench', 'each agent drives the full external-bench spine');
  assert.equal(a.stopReason, 'done');
  assert.ok(a.diff.startsWith('diff --git'), 'the extracted diff is carried');
  assert.equal(a.costUsd, 0.5, 'cost summed from the spine-drive telemetry');
  assert.equal(res.taskResults[0].disposition, 'spawn', 'always a fresh independent spawn, never warm-inject');
});

// ── the concurrency pool respects the cap ──────────────────────────────────────

test('su-independent: the concurrency pool never exceeds the fleet cap', async () => {
  const record: string[] = [];
  const { ops, maxLive } = fakeOps(record, { cap: 2 });
  const driver = suIndependentBacklogDriver(ops, { workspaceId: 'ws', sampleIntervalMs: 1 });
  const res = await driver.run(req({ backlog: backlog(6) })); // 6 tasks, cap 2 → waves of ≤2

  assert.equal(res.runError, undefined);
  assert.equal(res.taskResults.length, 6, 'all 6 tasks drained');
  assert.ok(maxLive() <= 2, `at most cap(=2) agents live at once (saw ${maxLive()})`);
  assert.ok(maxLive() >= 2, `the pool actually saturated to the cap (saw ${maxLive()})`);
  // The reported scalar peak matches the cap-bounded observed concurrency.
  assert.ok(res.peakConcurrentBees <= 2, 'peakConcurrentBees never exceeds the cap');
  assert.ok(res.peakConcurrentBees >= 2, 'peakConcurrentBees reflects real saturation');
});

test('su-independent: cap=1 serializes the backlog (the serial floor)', async () => {
  const record: string[] = [];
  const { ops, maxLive } = fakeOps(record, { cap: 1 });
  const driver = suIndependentBacklogDriver(ops, { workspaceId: 'ws', sampleIntervalMs: 1 });
  const res = await driver.run(req({ backlog: backlog(4) }));
  assert.equal(res.taskResults.length, 4);
  assert.equal(maxLive(), 1, 'cap=1 → strictly one agent at a time');
  assert.equal(res.peakConcurrentBees, 1);
});

// ── the concurrency timeline is populated ──────────────────────────────────────

test('su-independent: populates the concurrency timeline (samples + avg + peak)', async () => {
  const record: string[] = [];
  const { ops } = fakeOps(record, { cap: 3 });
  const driver = suIndependentBacklogDriver(ops, { workspaceId: 'ws', sampleIntervalMs: 1 });
  const res = await driver.run(req({ backlog: backlog(5) }));

  const tl = res.concurrencyTimeline;
  assert.ok(tl, 'the additive concurrencyTimeline field is populated');
  assert.ok(tl!.samples.length >= 2, 'at least the initial + final samples are recorded');
  // Each sample carries the elapsed time + the live count.
  for (const s of tl!.samples) {
    assert.ok(typeof s.tMs === 'number' && s.tMs >= 0, 'sample tMs is a non-negative elapsed-ms');
    assert.ok(typeof s.live === 'number' && s.live >= 0 && s.live <= 3, 'sample live is within [0, cap]');
  }
  assert.ok(tl!.peakConcurrent >= 0 && tl!.peakConcurrent <= 3, 'peakConcurrent within [0, cap]');
  assert.ok(tl!.avgConcurrent >= 0 && tl!.avgConcurrent <= tl!.peakConcurrent, 'avg ≤ peak');
  // The timeline peak reconciles with the scalar (both observe the same occupancy counter).
  assert.equal(tl!.peakConcurrent, res.peakConcurrentBees, 'timeline peak === peakConcurrentBees');
});

// ── the never-throw contract ───────────────────────────────────────────────────

test('su-independent: a single task throwing in runOneTask does NOT abort the pool (never-throw, partials)', async () => {
  const record: string[] = [];
  const { ops } = fakeOps(record, { cap: 2, throwOnRun: new Set(['instance_smoke__task-1']) });
  const driver = suIndependentBacklogDriver(ops, { workspaceId: 'ws', sampleIntervalMs: 1 });
  const res = await driver.run(req({ backlog: backlog(3) }));

  assert.equal(res.runError, undefined, 'one task failing is NOT a whole-run failure');
  assert.equal(res.taskResults.length, 3, 'every task still produces a result (the failure → an error row)');
  const failed = res.taskResults.find((r) => r.attempt.instanceId === 'instance_smoke__task-1')!;
  assert.equal(failed.attempt.stopReason, 'error', 'the throwing task → stopReason error');
  assert.match(failed.attempt.generationError ?? '', /run boom/, 'the infra error is surfaced, not thrown');
  assert.equal(failed.attempt.diff, '', 'a failed task carries no diff');
  // The failed task's checkout is still torn down (the finally path).
  assert.ok(record.includes('teardown:instance_smoke__task-1'), 'a failed task still tears down its checkout');
  // The other tasks succeeded.
  const ok = res.taskResults.filter((r) => r.attempt.stopReason === 'done');
  assert.equal(ok.length, 2);
});

test('su-independent: a prepareTask (clone) failure for one task → an error row, pool continues', async () => {
  const record: string[] = [];
  const { ops } = fakeOps(record, { cap: 2, throwOnPrepare: new Set(['instance_smoke__task-0']) });
  const driver = suIndependentBacklogDriver(ops, { workspaceId: 'ws', sampleIntervalMs: 1 });
  const res = await driver.run(req({ backlog: backlog(2) }));

  assert.equal(res.runError, undefined);
  assert.equal(res.taskResults.length, 2);
  const failed = res.taskResults.find((r) => r.attempt.instanceId === 'instance_smoke__task-0')!;
  assert.equal(failed.attempt.stopReason, 'error');
  assert.match(failed.attempt.generationError ?? '', /clone boom/);
  // A prepare failure never ran/tore-down (it never got a checkout).
  assert.ok(!record.includes('run:instance_smoke__task-0'), 'a clone failure never runs the agent');
});

test('su-independent: concurrencyCap throwing → a clean runError result (never throws to the caller)', async () => {
  const record: string[] = [];
  const { ops } = fakeOps(record);
  const broken: SuIndependentBacklogOps = {
    ...ops,
    concurrencyCap: () => {
      throw new Error('cap read boom');
    },
  };
  const driver = suIndependentBacklogDriver(broken, { workspaceId: 'ws', sampleIntervalMs: 1 });
  const res = await driver.run(req({ backlog: backlog(2) }));
  assert.match(res.runError ?? '', /cap read boom/, 'a top-level failure yields runError, not a throw');
  assert.ok(res.concurrencyTimeline, 'the timeline is still attached on the failure path');
});

// ── wall-clock timeout bounds the run ──────────────────────────────────────────

test('su-independent: a fleet wall-clock timeout stops pulling new tasks (bounded spend)', async () => {
  const record: string[] = [];
  // now() jumps past the deadline immediately so no worker pulls a task.
  let t = 0;
  const { ops } = fakeOps(record, { cap: 2 });
  const timedOps: SuIndependentBacklogOps = { ...ops, now: () => (t += 10_000) };
  const driver = suIndependentBacklogDriver(timedOps, { workspaceId: 'ws', fleetTimeoutMs: 1, sampleIntervalMs: 1 });
  const res = await driver.run(req({ backlog: backlog(5) }));
  assert.match(res.runError ?? '', /wall-clock timeout/, 'a timeout is reported as runError');
  assert.ok(res.taskResults.length < 5, 'the timeout stopped the backlog from fully draining');
});

// ── runHiveBacklog dispatch over the bound driver ──────────────────────────────

test('bindSuIndependentBacklogDriver wires runHiveBacklog (over injected fake ops)', async () => {
  const record: string[] = [];
  const { ops } = fakeOps(record, { cap: 2 });
  bindSuIndependentBacklogDriver({ workspaceId: 'ws', sampleIntervalMs: 1 }, ops);
  const res = await runHiveBacklog(req({ runId: 'r-bound', backlog: backlog(2) }));
  assert.equal(res.arm, SU_INDEPENDENT_ARM);
  assert.equal(res.taskResults.length, 2, 'the bound driver ran via runHiveBacklog');
  assert.ok(record.some((r) => r.startsWith('run:')), 'the injected fake ops drove the run');
});
