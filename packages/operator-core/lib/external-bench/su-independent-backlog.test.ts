/**
 * P-001 (benchmark-arms-su-vs-queen-expansion-2026-06-16) — the su-independent backlog driver. The
 * pure, NO-spend slices over INJECTED fake ops: proves the D-004-B lifecycle ordering
 * (createHive → per task: prepare → enroll → place(FIFO) → collect → teardownMember+teardownTask →
 * dissolveHive), the concurrency pool respects the fleet cap (≤cap agents live at once), the
 * live-concurrency timeline (peak/avg/samples) is populated, and the never-throw contract on every
 * per-task failure path (prepare/enroll/place/collect) + the top-level (concurrencyCap/createHive)
 * path. NO real git, NO PG, NO LLM, NO live spawns — every side effect is a fake. The arm routes
 * through a temporary shared hive (members spawn via FIFO through :3170) but emits NO Queen
 * coordination trace — that independence is the whole point. Mirrors hive-backlog-realqueen.test.ts.
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
  /** Hook to observe/record live concurrency at each task's collect start (for the pool-cap assertion). */
  onCollect?: (peakSeen: number) => void;
  /** Tasks whose collectTask should throw (spawn-collection failure path). */
  throwOnCollect?: Set<string>;
  /** Tasks whose prepareTask should throw (clone failure path). */
  throwOnPrepare?: Set<string>;
  /** Tasks whose enrollTask should throw (member-enroll failure path). */
  throwOnEnroll?: Set<string>;
  /** Tasks whose placeFifoBatch should throw (FIFO-spawn failure path — the real runtime regression). */
  throwOnPlace?: Set<string>;
}

/**
 * A fake ops implementing the full D-004-B {@link SuIndependentBacklogOps} surface. Records the call
 * sequence + tracks live concurrency itself (so the test can assert the pool never exceeds the cap).
 * `collectTask` is the in-flight window the driver brackets with enter()/exit(); it resolves on the
 * next microtask so multiple tasks are genuinely concurrent under Promise.all.
 */
function fakeOps(record: string[], o: FakeOpts = {}): { ops: SuIndependentBacklogOps; maxLive: () => number } {
  const cap = o.cap ?? 3;
  let live = 0;
  let maxLive = 0;
  const memberToId = new Map<string, string>(); // memberSlug → instanceId (place/teardownMember get only the slug)
  const ops: SuIndependentBacklogOps = {
    now: () => Date.now(),
    concurrencyCap: () => cap,
    async createHive({ runId }) {
      record.push(`createHive:${runId}`);
      return { hiveSlug: `hive-${runId}` };
    },
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
    async enrollTask({ task: t }) {
      record.push(`enroll:${t.instanceId}`);
      if (o.throwOnEnroll?.has(t.instanceId)) throw new Error(`enroll boom ${t.instanceId}`);
      const memberSlug = `m-${t.instanceId}`;
      memberToId.set(memberSlug, t.instanceId);
      return { memberSlug };
    },
    async placeFifoBatch({ memberSlug }) {
      const id = memberToId.get(memberSlug) ?? memberSlug;
      record.push(`place:${id}`);
      if (o.throwOnPlace?.has(id)) throw new Error(`place boom ${id}`);
      return { spawnId: `spawn-${memberSlug}` };
    },
    async collectTask({ enrolled }): Promise<SuTaskOutcome> {
      live += 1;
      if (live > maxLive) maxLive = live;
      o.onCollect?.(maxLive);
      record.push(`collect:${enrolled.task.instanceId}`);
      // Yield so sibling pool workers actually overlap (genuine concurrency under Promise.all).
      await Promise.resolve();
      await Promise.resolve();
      try {
        if (o.throwOnCollect?.has(enrolled.task.instanceId)) throw new Error(`collect boom ${enrolled.task.instanceId}`);
        return {
          diff: `diff --git a/${enrolled.task.instanceId} b`,
          telemetry: telemetry(),
          agentId: `agent-${enrolled.task.instanceId}`,
        };
      } finally {
        live -= 1;
      }
    },
    async teardownMember({ memberSlug }) {
      record.push(`teardownMember:${memberToId.get(memberSlug) ?? memberSlug}`);
    },
    async teardownTask({ enrolled }) {
      record.push(`teardown:${enrolled.task.instanceId}`);
    },
    async dissolveHive({ hiveSlug }) {
      record.push(`dissolveHive:${hiveSlug}`);
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

// ── createHive → (per task) prepare → enroll → place → collect → teardown → dissolveHive ──────────

test('su-independent: prepares, enrolls, spawns + collects ONE independent agent per task, tears it down, NO coord trace', async () => {
  const record: string[] = [];
  const { ops } = fakeOps(record, { cap: 3 });
  const driver = suIndependentBacklogDriver(ops, { workspaceId: 'ws', sampleIntervalMs: 1 });
  const res = await driver.run(req({ runId: 'r-lifecycle', backlog: backlog(2) }));

  assert.equal(res.runError, undefined, 'a clean run carries no runError');
  assert.equal(res.taskResults.length, 2, 'one result per backlog task');
  // The shared hive is created once up front and dissolved once at the end.
  assert.ok(record.includes('createHive:r-lifecycle'), 'the temporary shared hive is created once');
  assert.ok(record.includes('dissolveHive:hive-r-lifecycle'), 'the shared hive is dissolved once at the end');
  // Every task went prepare → collect → teardown (the bracketed per-task ordering).
  for (const i of [0, 1]) {
    const id = `instance_smoke__task-${i}`;
    const prep = record.indexOf(`prepare:${id}`);
    const collect = record.indexOf(`collect:${id}`);
    const td = record.indexOf(`teardown:${id}`);
    assert.ok(prep >= 0 && collect > prep && td > collect, `prepare→collect→teardown ordering for ${id}`);
    assert.ok(record.includes(`teardownMember:${id}`), `the member enrollment is torn down for ${id}`);
  }
  // An independent-agent arm produces NO coordination trace — that is the whole point.
  assert.equal(res.coordEvents.length, 0, 'su-independent emits NO coordEvents (no queen orchestration)');
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

// ── the never-throw contract: per-task failure paths ───────────────────────────

test('su-independent: a single task throwing in collectTask does NOT abort the pool (never-throw, partials)', async () => {
  const record: string[] = [];
  const { ops } = fakeOps(record, { cap: 2, throwOnCollect: new Set(['instance_smoke__task-1']) });
  const driver = suIndependentBacklogDriver(ops, { workspaceId: 'ws', sampleIntervalMs: 1 });
  const res = await driver.run(req({ backlog: backlog(3) }));

  assert.equal(res.runError, undefined, 'one task failing is NOT a whole-run failure');
  assert.equal(res.taskResults.length, 3, 'every task still produces a result (the failure → an error row)');
  const failed = res.taskResults.find((r) => r.attempt.instanceId === 'instance_smoke__task-1')!;
  assert.equal(failed.attempt.stopReason, 'error', 'the throwing task → stopReason error');
  assert.match(failed.attempt.generationError ?? '', /collect boom/, 'the infra error is surfaced, not thrown');
  assert.equal(failed.attempt.diff, '', 'a failed task carries no diff');
  // The failed task's member + checkout are still torn down (the finally path).
  assert.ok(record.includes('teardownMember:instance_smoke__task-1'), 'a failed task still tears down its member');
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
  // A prepare failure never enrolled/collected/tore-down (it never got a checkout or a member).
  assert.ok(!record.includes('collect:instance_smoke__task-0'), 'a clone failure never collects the agent');
  assert.ok(!record.includes('enroll:instance_smoke__task-0'), 'a clone failure never enrolls a member');
});

test('su-independent: a placeFifoBatch (FIFO-spawn) failure → an error row, member + checkout torn down, pool continues', async () => {
  const record: string[] = [];
  const { ops } = fakeOps(record, { cap: 2, throwOnPlace: new Set(['instance_smoke__task-0']) });
  const driver = suIndependentBacklogDriver(ops, { workspaceId: 'ws', sampleIntervalMs: 1 });
  const res = await driver.run(req({ backlog: backlog(2) }));

  assert.equal(res.runError, undefined, 'a single place failure is NOT a whole-run failure');
  assert.equal(res.taskResults.length, 2);
  const failed = res.taskResults.find((r) => r.attempt.instanceId === 'instance_smoke__task-0')!;
  assert.equal(failed.attempt.stopReason, 'error');
  assert.match(failed.attempt.generationError ?? '', /place boom/, 'the place failure is surfaced as the generation error');
  // A place failure never reaches collect, but DOES tear down the enrolled member + checkout.
  assert.ok(!record.includes('collect:instance_smoke__task-0'), 'a place failure never collects the agent');
  assert.ok(record.includes('teardownMember:instance_smoke__task-0'), 'a place failure tears down the member');
  assert.ok(record.includes('teardown:instance_smoke__task-0'), 'a place failure tears down the checkout');
  // The other task still ran to done.
  assert.equal(res.taskResults.filter((r) => r.attempt.stopReason === 'done').length, 1);
});

// ── the never-throw contract: top-level failure path ───────────────────────────

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
  // Even a top-level failure dissolves the hive it had already created (best-effort cleanup).
  assert.ok(
    record.some((r) => r.startsWith('dissolveHive:')),
    'the shared hive is dissolved even on the top-level failure path',
  );
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
  assert.ok(record.some((r) => r.startsWith('collect:')), 'the injected fake ops drove the run');
});
