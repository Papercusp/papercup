import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTaskBudgetRefusal } from '../../../../scripts/lib/task-exit-class.mjs';
import {
  admissionMutexName,
  classifyAffectedBlastRadius,
  durationEstimate,
  emptyDurationHistory,
  formatAdmissionHolder,
  formatAdmissionProspect,
  formatAffectedTaskShardMarker,
  formatTaskBudgetMarker,
  formatTaskBudgetObservedMarker,
  isSharedAdmissionTimeout,
  mergeDurationHistory,
  pidsEventRefusalDelta,
  planAffectedTaskShards,
  readDurationHistory,
  readTaskCgroupMemoryMaxMb,
  readTaskCgroupPidsEventMax,
  readTaskCgroupPidsMax,
  resolveGlobalWorkerBudget,
  resolveMemoryBudgetMb,
  resolveTaskBudget,
  resolveWorkerMemoryMb,
  runBudgetedTaskShards,
  runBudgetedTasks,
  timeoutDurationEstimate,
  writeDurationHistoryAtomic,
} from '../../../../scripts/lib/budgeted-task-scheduler.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS policy module, no declaration file.
import { resolveTaskTimeoutMs } from '../../../../scripts/lib/batch-watchdog.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-Node entrypoint, consumed directly by scripts/*.mjs.
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS_SRC = readFileSync(resolve(REPO_ROOT, 'scripts/affected-tests.mjs'), 'utf8');
const SCHEDULER_SRC = readFileSync(
  resolve(REPO_ROOT, 'scripts/lib/budgeted-task-scheduler.mjs'),
  'utf8',
);

// HYGIENE, NOT A FIX — do not read this as the reason the timeouts went away.
//
// 33466aadb9 wrapped `runBudgetedTasks` in the SHARED, cross-process admission mutex
// (`papercusp-test-process-admission`, 4h timeout). A unit test asserting allocation
// logic has no business taking the production lock the real runner uses, so this
// redirects the lock root to a per-file temp dir: these tests take a REAL lock that
// nobody else contends on, and a leaked one cannot reach another process.
//
// It is worth being explicit that this did NOT fix the 9 timeouts, because I first
// believed it would and said so. Measured with this redirect in place and the mutex
// otherwise live: 552s / 9 timeouts / 12 failed — IDENTICAL to without it. So
// cross-process contention was never the cause. The real cause is the tick-count
// assumption documented on `until` below; see EI-21882326796062266 for the
// falsification.
//
// Deliberately not PAPERCUSP_DISABLE_FS_MUTEX: that removes the mechanism entirely
// and silently breaks the one test asserting the gate actually serializes.
// The gate test already redirects the root this same way and restores whatever it
// found — which is now this dir, so it keeps working unchanged.
let mutexLockRoot: string;
let previousMutexLockRoot: string | undefined;
beforeAll(() => {
  previousMutexLockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  mutexLockRoot = mkdtempSync(join(tmpdir(), 'pc-budgeted-scheduler-locks-'));
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = mutexLockRoot;
});
afterAll(() => {
  if (previousMutexLockRoot === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousMutexLockRoot;
  rmSync(mutexLockRoot, { recursive: true, force: true });
});

const config = {
  workerBudget: 4,
  memoryBudgetMb: 4096,
  workerMemoryMb: 1024,
  maxConcurrentTasks: 2,
  reserveWorkers: 1,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * Wait for an OBSERVED condition instead of guessing how many ticks it takes.
 *
 * 33466aadb9 put an async filesystem-mutex acquisition (`withFsMutex`) in front of
 * task admission. `await Promise.resolve()` — one microtask — was enough to observe
 * admission before that, and is not now: the assertions saw `starts` still EMPTY.
 *
 * That cost far more than three assertion failures. A test that fails mid-flight
 * abandons a `runBudgetedTasks` which is still HOLDING the mutex (its fake `runTask`
 * gates never resolve, so `withFsMutex` never reaches its release). Every later call
 * in the process then blocked until vitest's 60s cap — 9 of them, ~9.2 min of every
 * canonical run, presenting as timeouts with no connection to the real defect.
 *
 * MEASURED: the first timing-out test PASSES ALONE in 13s (`-t`), and the first
 * assertion failure reproduces alone in 12s with 0 timeouts. So the timeouts are
 * collateral from the earlier failures, not independent hangs.
 *
 * Waiting on the signal is robust to however much async sits in front of admission,
 * which is the property a fixed tick count never had.
 */
async function until(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((done) => setImmediate(done));
  }
}

describe('runBudgetedTasks', () => {
  it('gives the longest task all but one worker and overlaps the shortest on the reserved lane', async () => {
    const tasks = [
      { id: 'long', estimateMs: 100 },
      { id: 'medium', estimateMs: 50 },
      { id: 'short', estimateMs: 5 },
    ];
    const gates = new Map(tasks.map((task) => [task.id, deferred<string>()]));
    const starts: Array<{ id: string; lane: string; workers: number }> = [];
    const running = runBudgetedTasks(tasks, {
      ...config,
      estimateMs: (task: (typeof tasks)[number]) => task.estimateMs,
      runTask: async (task: (typeof tasks)[number], allocation: { lane: string; workers: number }) => {
        starts.push({ id: task.id, lane: allocation.lane, workers: allocation.workers });
        return gates.get(task.id)!.promise;
      },
    });

    await until(() => starts.length >= 2, 'the first two admissions');
    expect(starts).toEqual([
      { id: 'long', lane: 'primary', workers: 3 },
      { id: 'short', lane: 'reserved', workers: 1 },
    ]);
    gates.get('short')!.resolve('short-result');
    await new Promise<void>((done) => setImmediate(done));
    expect(starts[2]).toEqual({ id: 'medium', lane: 'reserved', workers: 1 });
    gates.get('medium')!.resolve('medium-result');
    gates.get('long')!.resolve('long-result');

    const result = await running;
    expect(result.results.map((entry: { task: { id: string } }) => entry.task.id)).toEqual(['long', 'medium', 'short']);
    expect(result.results.map((entry: { value: string }) => entry.value)).toEqual([
      'long-result',
      'medium-result',
      'short-result',
    ]);
    expect(result.stats.observedMaxWorkers).toBe(4);
    expect(result.stats.observedMaxMemoryMb).toBe(4096);
    expect(result.stats.observedMaxTasks).toBe(2);
  });

  it('publishes a settled task before an in-flight sibling lets the pool return', async () => {
    const tasks = [
      { id: 'long', estimateMs: 100 },
      { id: 'short', estimateMs: 5 },
    ];
    const gates = new Map(tasks.map((task) => [task.id, deferred<string>()]));
    const settled: string[] = [];
    // Admission is the thing we have to wait for, so it has to be observable —
    // this test previously had no record of it and relied on a microtask tick.
    const started: string[] = [];
    let poolReturned = false;
    const running = runBudgetedTasks(tasks, {
      ...config,
      estimateMs: (task: (typeof tasks)[number]) => task.estimateMs,
      runTask: (task: (typeof tasks)[number]) => {
        started.push(task.id);
        return gates.get(task.id)!.promise;
      },
      onTaskSettled: (entry: { task: { id: string } }) => {
        settled.push(entry.task.id);
      },
    });
    void running.then(() => {
      poolReturned = true;
    });

    await until(() => started.length >= 2, 'both tasks to be admitted');
    gates.get('short')!.resolve('short-result');
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toEqual(['short']);
    expect(poolReturned).toBe(false);

    gates.get('long')!.resolve('long-result');
    await expect(running).resolves.toMatchObject({
      results: [{ task: { id: 'long' } }, { task: { id: 'short' } }],
    });
    expect(settled).toEqual(['short', 'long']);
  });

  it('lets the memory budget reduce the worker ceiling independently', async () => {
    const allocations: number[] = [];
    const result = await runBudgetedTasks(['a', 'b'], {
      ...config,
      workerBudget: 8,
      memoryBudgetMb: 2048,
      runTask: async (_task: string, allocation: { workers: number }) => {
        allocations.push(allocation.workers);
      },
    });
    expect(result.stats.effectiveWorkerBudget).toBe(2);
    expect(result.stats.observedMaxWorkers).toBeLessThanOrEqual(2);
    expect(result.stats.observedMaxMemoryMb).toBeLessThanOrEqual(2048);
    expect(allocations.sort()).toEqual([1, 1]);
  });

  it('collapses to serial when the global budget cannot fund a reserved lane', async () => {
    let active = 0;
    let highWater = 0;
    const result = await runBudgetedTasks(['a', 'b', 'c'], {
      ...config,
      workerBudget: 1,
      memoryBudgetMb: 1024,
      runTask: async () => {
        active++;
        highWater = Math.max(highWater, active);
        await Promise.resolve();
        active--;
      },
    });
    expect(result.stats.mode).toBe('serial');
    expect(result.stats.observedMaxWorkers).toBe(1);
    expect(result.stats.observedMaxTasks).toBe(1);
    expect(highWater).toBe(1);
  });

  it('honours an explicit one-task ceiling even when worker and memory tokens are plentiful', async () => {
    const result = await runBudgetedTasks(['a', 'b'], {
      ...config,
      maxConcurrentTasks: 1,
      runTask: async () => undefined,
    });
    expect(result.stats.mode).toBe('serial');
    expect(result.stats.observedMaxTasks).toBe(1);
    expect(result.stats.observedMaxWorkers).toBe(4);
  });

  it('rejects a memory budget that cannot admit even one worker token', () => {
    expect(() => resolveTaskBudget({ ...config, memoryBudgetMb: 512 })).toThrow(
      /cannot admit one workerMemoryMb=1024 token/,
    );
  });

  it('drains the other in-flight lane after a rejection without admitting another task', async () => {
    const tasks = [
      { id: 'long', estimateMs: 100 },
      { id: 'medium', estimateMs: 50 },
      { id: 'short', estimateMs: 5 },
    ];
    const gates = new Map(tasks.map((task) => [task.id, deferred<string>()]));
    const starts: string[] = [];
    const running = runBudgetedTasks(tasks, {
      ...config,
      estimateMs: (task: (typeof tasks)[number]) => task.estimateMs,
      runTask: (task: (typeof tasks)[number]) => {
        starts.push(task.id);
        return gates.get(task.id)!.promise;
      },
    });
    const outcome = running.then(
      () => ({ error: null as Error | null }),
      (error: Error) => ({ error }),
    );

    await until(() => starts.length >= 2, 'long and short to be admitted');
    expect(starts).toEqual(['long', 'short']);
    gates.get('long')!.reject(new Error('primary failed'));
    await new Promise<void>((done) => setImmediate(done));
    expect(starts).toEqual(['long', 'short']);

    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    gates.get('short')!.resolve('short-result');
    expect((await outcome).error?.message).toBe('primary failed');
    expect(starts).toEqual(['long', 'short']);
  });

  it('serializes concurrent scheduler invocations behind the shared process admission gate', async () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'pc-test-process-admission-'));
    const previousLockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = lockRoot;
    const firstStarted = deferred<void>();
    const firstRelease = deferred<void>();
    const starts: string[] = [];
    let active = 0;
    let peak = 0;

    const runInvocation = (id: string, waitFor?: Promise<void>) =>
      runBudgetedTasks([id], {
        ...config,
        maxConcurrentTasks: 1,
        runTask: async () => {
          starts.push(id);
          active += 1;
          peak = Math.max(peak, active);
          if (id === 'first') firstStarted.resolve();
          if (waitFor) await waitFor;
          active -= 1;
          return id;
        },
      });

    try {
      const first = runInvocation('first', firstRelease.promise);
      await firstStarted.promise;

      const second = runInvocation('second');
      await new Promise<void>((resolveNext) => setImmediate(resolveNext));
      expect(starts).toEqual(['first']);
      expect(peak).toBe(1);

      firstRelease.resolve();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(starts).toEqual(['first', 'second']);
      expect(peak).toBe(1);
    } finally {
      if (previousLockRoot === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
      else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousLockRoot;
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });
});

describe('near-tree-wide deterministic sharding (P-011)', () => {
  const broad = classifyAffectedBlastRadius({ changedPaths: ['package-lock.json'] });

  it('classifies root manifests/config as near-tree-wide and ordinary source as scoped', () => {
    expect(broad).toMatchObject({ kind: 'near-tree-wide', reason: 'root-manifest-or-config' });
    expect(classifyAffectedBlastRadius({ changedPaths: ['tsconfig.base.json'] }).kind).toBe('near-tree-wide');
    expect(classifyAffectedBlastRadius({ changedPaths: ['packages/operator-core/lib/a.ts'] }).kind).toBe('scoped');
    expect(classifyAffectedBlastRadius({ runAll: true }).reason).toBe('all-requested');
    expect(classifyAffectedBlastRadius({ derivationDegraded: true }).reason).toBe('derivation-degraded');
  });

  it('preserves the exact union once, in declaration order, across bounded shards', () => {
    const tasks = Array.from({ length: 10 }, (_, id) => ({ id }));
    const plan = planAffectedTaskShards(tasks, {
      blastRadius: broad,
      maxTasksPerShard: 3,
      taskKey: (task) => task.id,
    });
    expect(plan.shards.map((shard) => shard.tasks.length)).toEqual([3, 3, 3, 1]);
    expect(plan.shards.flatMap((shard) => shard.tasks.map((task) => task.id))).toEqual(tasks.map((task) => task.id));
    expect(new Set(plan.shards.flatMap((shard) => shard.taskKeys)).size).toBe(tasks.length);
    expect(formatAffectedTaskShardMarker(plan, 8192)).toContain('shards=4');
  });

  it('fails before launch when the finalized task set contains a duplicate', () => {
    expect(() =>
      planAffectedTaskShards([{ id: 'a' }, { id: 'a' }], {
        blastRadius: broad,
        maxTasksPerShard: 2,
        taskKey: (task) => task.id,
      }),
    ).toThrow(/duplicate affected task/);
  });

  it('runs shards sequentially while keeping each shard under the scheduler topology cap', async () => {
    const tasks = Array.from({ length: 7 }, (_, id) => ({ id }));
    const plan = planAffectedTaskShards(tasks, {
      blastRadius: broad,
      maxTasksPerShard: 3,
      taskKey: (task) => task.id,
    });
    let active = 0;
    let peak = 0;
    const run = await runBudgetedTaskShards(plan, {
      ...config,
      runTask: async (task) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return task.id;
      },
    });
    expect(run.results.map((entry) => entry.value)).toEqual(tasks.map((task) => task.id));
    expect(run.shardStats).toHaveLength(3);
    expect(peak).toBeLessThanOrEqual(config.maxConcurrentTasks);
    expect(run.stats.observedMaxWorkers).toBeLessThanOrEqual(config.workerBudget);
  });
});

describe('runBudgetedTasks memory-aware admission (EI-20801764054303492 route (a))', () => {
  // Serialised so each admission is a separate, ordered event: the clamp is a per-ADMISSION
  // decision, and interleaved lanes would make the assertion order-dependent rather than wrong.
  const serialConfig = { ...config, maxConcurrentTasks: 1 };

  /** Readings are consumed in order; the last one repeats once exhausted. */
  function readerFrom(readings: Array<number | null>) {
    let i = 0;
    const calls: number[] = [];
    const read = () => {
      const value = readings[Math.min(i, readings.length - 1)];
      i += 1;
      calls.push(i);
      return value;
    };
    return { read, callCount: () => calls.length };
  }

  async function widthsFor(options: Record<string, unknown>) {
    const widths: number[] = [];
    const result = await runBudgetedTasks(['a', 'b', 'c'], {
      ...serialConfig,
      ...options,
      runTask: async (_task: string, allocation: { workers: number }) => {
        widths.push(allocation.workers);
      },
    });
    return { widths, stats: result.stats };
  }

  // WI-41206 / remove-memory-derived-work-refusals-2026-08-24: admission is no longer narrowed
  // by the reading. The MEASUREMENT is still taken and still reported (memoryReadings,
  // lastMemAvailableMb) — losing the observability was never the goal — but it no longer moves
  // the lane width, so admissionClamps is now always 0.
  it('still MEASURES memory each admission, but no longer clamps the width', async () => {
    // Previously: 3000MB afforded 2 workers and 2000MB afforded 1, against a 4-worker lane.
    const reader = readerFrom([3000, 2000]);
    const { widths, stats } = await widthsFor({ readMemAvailableMb: reader.read });

    expect(widths[0]).toBe(4);
    expect(widths.slice(1)).toEqual([4, 4]);
    // The reader is still consulted on every post-startup admission — the telemetry survives.
    expect(reader.callCount()).toBe(2);
    expect(stats.memoryReadings).toBe(2);
    expect(stats.admissionClamps).toBe(0);
    expect(stats.minAdmittedWorkers).toBe(4);
    expect(stats.lastMemAvailableMb).toBe(2000);
  });

  it('never lets a clamped run exceed the peak of the same run unclamped', async () => {
    const unclamped = await widthsFor({});
    const clamped = await widthsFor({ readMemAvailableMb: readerFrom([2000]).read });

    expect(clamped.stats.observedMaxWorkers).toBeLessThanOrEqual(unclamped.stats.observedMaxWorkers);
    expect(clamped.stats.observedMaxMemoryMb).toBeLessThanOrEqual(unclamped.stats.observedMaxMemoryMb);
    // The peak can still be SET by the unmeasured first admission — that is the documented cost
    // of skipping the re-measure there, pinned so a future change to that rule is visible.
    expect(clamped.widths[0]).toBe(unclamped.widths[0]);
  });

  it('leaves allocations byte-identical to a no-reader run when the reading is null', async () => {
    const baseline = await widthsFor({});
    const withNullReader = await widthsFor({ readMemAvailableMb: () => null });

    expect(withNullReader.widths).toEqual(baseline.widths);
    expect(withNullReader.stats.observedMaxWorkers).toBe(baseline.stats.observedMaxWorkers);
    expect(withNullReader.stats.observedMaxMemoryMb).toBe(baseline.stats.observedMaxMemoryMb);
    expect(withNullReader.stats.admissionClamps).toBe(0);
    // A null reading is still a READING — it just carries no number to clamp with.
    expect(withNullReader.stats.memoryReadings).toBe(2);
    expect(withNullReader.stats.lastMemAvailableMb).toBeNull();
    // No reader at all reports null, which is what keeps the legacy marker string intact.
    expect(baseline.stats.memoryReadings).toBeNull();
  });

  it('does not fail the run when the reader THROWS', async () => {
    const baseline = await widthsFor({});
    const { widths, stats } = await widthsFor({
      readMemAvailableMb: () => {
        throw new Error('meminfo unreadable');
      },
    });

    // A broken instrument must not read as "no memory" — that would throttle a healthy box to 1.
    expect(widths).toEqual(baseline.widths);
    expect(stats.admissionClamps).toBe(0);
    expect(stats.memoryReadings).toBe(0);
  });

  it('keeps the full lane even at a zero reading (WI-41206)', async () => {
    // The old contract narrowed to a single worker here. The reasoning behind that floor —
    // "refusing admission outright would deadlock a run already under memory pressure" — is
    // exactly the argument extended: the run proceeds at full width and the host slows itself
    // through real contention rather than through a pre-emptive narrowing.
    const { widths, stats } = await widthsFor({ readMemAvailableMb: () => 0 });

    expect(widths.slice(1).every((w) => w === 4)).toBe(true);
    expect(stats.minAdmittedWorkers).toBe(4);
    expect(stats.admissionClamps).toBe(0);
  });
});

describe('resolveGlobalWorkerBudget', () => {
  it('keeps the green-checkpoint two-fork rail binding when modern max-workers was filled higher', () => {
    expect(
      resolveGlobalWorkerBudget({
        vitestMaxWorkers: '12',
        vitestMaxForks: '2',
        vitestMaxThreads: '2',
        fallback: 12,
      }),
    ).toBe(2);
  });

  it('lets an affected-tests-specific ceiling tighten but never widen an inherited limit', () => {
    expect(
      resolveGlobalWorkerBudget({
        affectedWorkerBudget: '1',
        vitestMaxWorkers: '12',
        fallback: 12,
      }),
    ).toBe(1);
    expect(
      resolveGlobalWorkerBudget({
        affectedWorkerBudget: '16',
        vitestMaxWorkers: '4',
        fallback: 12,
      }),
    ).toBe(4);
  });
});

describe('resolveWorkerMemoryMb', () => {
  it('accounts for the inherited V8 heap instead of understating a gate worker as 1 GiB', () => {
    expect(
      resolveWorkerMemoryMb({
        nodeOptions: '--expose-gc --max-old-space-size=4096',
        fallback: 1024,
      }),
    ).toBe(4096);
  });

  it('accepts both NODE_OPTIONS spellings and never lets an explicit estimate shrink the heap', () => {
    expect(
      resolveWorkerMemoryMb({
        affectedWorkerMemoryMb: '2048',
        nodeOptions: '--max_old_space_size 8192',
        fallback: 1024,
      }),
    ).toBe(8192);
  });
});

describe('resolveMemoryBudgetMb', () => {
  // WI-39472: the caller's old default (workerBudget * workerMemoryMb) made memoryWorkerBudget
  // identically equal to workerBudget, so resolveTaskBudget's Math.min could NEVER bind and the
  // memory rail was inert. These cases pin the property that made it inert, so a regression to
  // the old default fails here rather than silently un-arming the clamp again.
  const base = { workerBudget: 8, workerMemoryMb: 1024 };

  // WI-41206 / remove-memory-derived-work-refusals-2026-08-24: these three asserted that the
  // reading BOUND the budget. It no longer does — a host driven into paging should slow down
  // from real contention, not from a snapshot narrowing the lane pre-emptively. The ceiling
  // property (never widen past the worker budget) is unchanged and still pinned below.
  it('does NOT bind on available memory — a loaded host keeps its full worker ceiling', () => {
    // Previously: 4096 MiB available, 25% reserved => 3072 usable => 3 tokens.
    const budget = resolveMemoryBudgetMb({ ...base, memAvailableMb: 4096 });
    expect(budget).toBe(8 * 1024);
    expect(
      resolveTaskBudget({ ...base, memoryBudgetMb: budget, maxConcurrentTasks: 8, reserveWorkers: 1 }),
    ).toMatchObject({
      memoryWorkerBudget: 8,
      effectiveWorkerBudget: 8,
    });
  });

  it('NEVER widens the budget past the worker ceiling, however much memory is free', () => {
    // Unchanged by WI-41206: the ceiling is a WORKER budget, not a memory one.
    expect(resolveMemoryBudgetMb({ ...base, memAvailableMb: 1024 * 1024 })).toBe(8 * 1024);
  });

  it('a near-zero reading no longer degrades the host to serial', () => {
    // Previously 100 MiB available floored the budget to a single 1024 MiB worker.
    expect(resolveMemoryBudgetMb({ ...base, memAvailableMb: 100 })).toBe(8 * 1024);
    expect(() =>
      resolveTaskBudget({ ...base, memoryBudgetMb: 8 * 1024, maxConcurrentTasks: 8, reserveWorkers: 1 }),
    ).not.toThrow();
  });

  it('returns the SAME budget for every reading, all else equal (WI-41206 regression guard)', () => {
    const at = (memAvailableMb: number) => resolveMemoryBudgetMb({ ...base, memAvailableMb });
    expect(at(100)).toBe(at(1024 * 1024));
  });

  it('lets an explicit AFFECTED_GLOBAL_MEMORY_MB win over the measured host', () => {
    expect(resolveMemoryBudgetMb({ ...base, affectedGlobalMemoryMb: '2048', memAvailableMb: 999_999 })).toBe(2048);
  });

  it('caps against the hard task cgroup memory.max without re-arming host-memory heuristics', () => {
    expect(resolveMemoryBudgetMb({ ...base, memAvailableMb: 1, taskCgroupMemoryMaxMb: 4096 })).toBe(3072);
    expect(
      resolveMemoryBudgetMb({
        ...base,
        affectedGlobalMemoryMb: 7000,
        taskCgroupMemoryMaxMb: 4096,
      }),
    ).toBe(3072);
    expect(() =>
      resolveMemoryBudgetMb({
        ...base,
        taskCgroupMemoryMaxMb: 1024,
      }),
    ).toThrow(/refusing before launch/);
  });

  it('reads memory.max from the current unified cgroup and treats max/unreadable as unbounded', () => {
    const files = new Map([
      ['/proc/self/cgroup', '0::/user.slice/test.scope\n'],
      ['/sys/fs/cgroup/user.slice/test.scope/memory.max', String(8 * 1024 * 1024 * 1024)],
    ]);
    const readFile = (path: string) => {
      if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(path)!;
    };
    expect(readTaskCgroupMemoryMaxMb({ readFile })).toBe(8192);
    files.set('/sys/fs/cgroup/user.slice/test.scope/memory.max', 'max');
    expect(readTaskCgroupMemoryMaxMb({ readFile })).toBeNull();
  });

  it('reads pids.max from the current unified cgroup and treats max/unreadable as unbounded', () => {
    const files = new Map([
      ['/proc/self/cgroup', '0::/user.slice/test.scope\n'],
      ['/sys/fs/cgroup/user.slice/test.scope/pids.max', '2048'],
    ]);
    const readFile = (path: string) => {
      if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(path)!;
    };
    expect(readTaskCgroupPidsMax({ readFile })).toBe(2048);
    files.set('/sys/fs/cgroup/user.slice/test.scope/pids.max', 'max');
    expect(readTaskCgroupPidsMax({ readFile })).toBeNull();
  });

  it('reads the cumulative refused-fork count from pids.events', () => {
    const files = new Map([
      ['/proc/self/cgroup', '0::/user.slice/test.scope\n'],
      ['/sys/fs/cgroup/user.slice/test.scope/pids.events', 'max 121\n'],
    ]);
    const readFile = (path: string) => {
      if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(path)!;
    };
    expect(readTaskCgroupPidsEventMax({ readFile })).toBe(121);
    files.set('/sys/fs/cgroup/user.slice/test.scope/pids.events', 'max not-a-number');
    expect(readTaskCgroupPidsEventMax({ readFile })).toBeNull();
  });

  it('invalidates only red runs when the cgroup refused forks during the run', () => {
    expect(pidsEventRefusalDelta({ start: 30, end: 121, hasFailures: true })).toBe(91);
    expect(pidsEventRefusalDelta({ start: 30, end: 121, hasFailures: false })).toBe(0);
    expect(pidsEventRefusalDelta({ start: 121, end: 121, hasFailures: true })).toBe(0);
    expect(pidsEventRefusalDelta({ start: null, end: 121, hasFailures: true })).toBe(0);
  });

  it('serializes an 8192-pid task scope instead of admitting two peak-sized test tasks', () => {
    const resolved = resolveTaskBudget({ ...config, taskCgroupPidsMax: 8192 });
    expect(resolved).toMatchObject({
      mode: 'serial',
      maxConcurrentTasks: 1,
      configuredMaxConcurrentTasks: 2,
      pidsMaxConcurrentTasks: 1,
      taskBoundBy: 'pids',
    });
    const marker = formatTaskBudgetMarker(resolved);
    expect(marker).toContain('effectiveWorkers=4 maxTasks=1 reserveWorkers=1');
    expect(marker).toContain(
      'configuredMaxTasks=2 pidsMaxTasks=1 taskBoundBy=pids ' +
        'taskCgroupPidsMax=8192 pidsPerTask=4096 pidsReserve=1024',
    );
  });

  it('adapts a 512-pid task scope to one serial task instead of refusing', () => {
    const resolved = resolveTaskBudget({ ...config, taskCgroupPidsMax: 512 });
    expect(resolved).toMatchObject({
      mode: 'serial',
      maxConcurrentTasks: 1,
      configuredMaxConcurrentTasks: 2,
      pidsMaxConcurrentTasks: 1,
      taskBoundBy: 'pids',
      pidsBudgetAdapted: true,
      pidsReserve: 102,
      pidsPerConcurrentTask: 410,
    });
    expect(resolved.pidsReserve + resolved.pidsPerConcurrentTask).toBe(512);
  });

  it('adapts a 4096-pid task scope to one serial task instead of refusing', () => {
    const resolved = resolveTaskBudget({ ...config, taskCgroupPidsMax: 4096 });
    expect(resolved).toMatchObject({
      mode: 'serial',
      maxConcurrentTasks: 1,
      configuredMaxConcurrentTasks: 2,
      pidsMaxConcurrentTasks: 1,
      taskBoundBy: 'pids',
      pidsBudgetAdapted: true,
      pidsReserve: 819,
      pidsPerConcurrentTask: 3277,
    });
    expect(resolved.pidsReserve + resolved.pidsPerConcurrentTask).toBe(4096);
  });

  it('keeps two-task scheduling only when both 4096-task envelopes plus reserve fit', () => {
    expect(resolveTaskBudget({ ...config, taskCgroupPidsMax: 9216 })).toMatchObject({
      mode: 'parallel',
      maxConcurrentTasks: 2,
      pidsMaxConcurrentTasks: 2,
      taskBoundBy: 'ceiling',
    });
    expect(() => resolveTaskBudget({ ...config, taskCgroupPidsMax: 0 })).toThrow(
      /below one pidsPerConcurrentTask=4096 envelope; refusing before launch/,
    );
  });

  // EI-21442389733525112. These refusals are the ONLY evidence that a pre-launch refusal
  // happened: nothing is spawned, so the task ledger never samples pids and every downstream
  // caller sees a bare non-zero exit. Round-tripping the REAL thrown message through the REAL
  // parser is what keeps the emitter and the reader on one grammar — a hand-copied literal on
  // either side would let them drift apart silently, and the symptom of that drift is a
  // resource refusal being read as a red test suite.
  it('emits a machine-readable refusal marker the shared parser recovers, on both refusal sites', () => {
    const pidsMessage = (() => {
      try {
        resolveTaskBudget({ ...config, taskCgroupPidsMax: 0 });
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(pidsMessage).not.toBeNull();
    expect(parseTaskBudgetRefusal(pidsMessage!)).toEqual({
      kind: 'pids',
      unit: 'tasks',
      limit: 0,
      reserve: 1_024,
      requiredPerTask: 4_096,
    });

    const memoryMessage = (() => {
      try {
        resolveMemoryBudgetMb({ ...base, taskCgroupMemoryMaxMb: 1024 });
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(memoryMessage).not.toBeNull();
    expect(parseTaskBudgetRefusal(memoryMessage!)).toMatchObject({
      kind: 'memory',
      unit: 'mb',
      limit: 1_024,
    });

    // The human sentence must survive alongside the marker — the marker is added evidence,
    // not a replacement for a message a person has to read at 3am.
    expect(pidsMessage).toContain('refusing before launch');
    expect(pidsMessage).toContain('remedy=processes:limit');
  });

  it('does not emit a refusal marker on a budget that resolves', () => {
    const marker = formatTaskBudgetMarker(resolveTaskBudget({ ...config, taskCgroupPidsMax: 8192 }));
    expect(parseTaskBudgetRefusal(marker)).toBeNull();
  });

  it('falls back to the ceiling when the host reading is unavailable, never to zero', () => {
    expect(resolveMemoryBudgetMb({ ...base, memAvailableMb: null })).toBe(8 * 1024);
    expect(resolveMemoryBudgetMb({ ...base, memAvailableMb: '' })).toBe(8 * 1024);
  });

  it('rejects a nonsensical reserve fraction instead of silently admitting everything', () => {
    expect(() => resolveMemoryBudgetMb({ ...base, memAvailableMb: 4096, reserveFraction: 1 })).toThrow(
      /reserveFraction/,
    );
    expect(() => resolveMemoryBudgetMb({ ...base, memAvailableMb: 4096, reserveFraction: -0.5 })).toThrow(
      /reserveFraction/,
    );
  });
});

describe('duration history', () => {
  it('keeps an EWMA and treats missing or malformed history as unknown', () => {
    const empty = emptyDurationHistory();
    expect(durationEstimate(empty, 'missing')).toBeNull();
    const first = mergeDurationHistory(empty, [{ key: 'a :: test', durationMs: 1000 }], 't1');
    const second = mergeDurationHistory(first, [{ key: 'a :: test', durationMs: 3000 }], 't2');
    expect(second.tasks['a :: test']).toEqual({
      durationMs: 1500,
      peakMs: 3000,
      samples: 2,
      updatedAt: 't2',
    });
  });

  // EI-20803703725014949: lane-stateful is bimodal (~7m vs ~45m, both honest
  // completions). The watchdog bound must clear the honest SLOW mode even when
  // the EWMA has been dragged down by a run of fast finishes — otherwise the
  // timeout collapses to its floor and a legitimate slow finish races a timer
  // set at exactly its own duration (the measured ~50% SIGKILL coin flip).
  it('timeoutDurationEstimate keeps the slow mode of a bimodal task alive through fast runs', () => {
    const SLOW = 45 * 60_000;
    const FAST = 7 * 60_000;
    let history = mergeDurationHistory(emptyDurationHistory(), [{ key: 'oc :: lane', durationMs: SLOW }], 't1');
    for (let i = 0; i < 4; i += 1) {
      history = mergeDurationHistory(history, [{ key: 'oc :: lane', durationMs: FAST }], `t${i + 2}`);
    }
    const ewma = durationEstimate(history, 'oc :: lane');
    const forTimeout = timeoutDurationEstimate(history, 'oc :: lane');
    // The EWMA has collapsed well below the slow mode…
    expect(ewma).toBeLessThan(SLOW / 2);
    // …but the peak-aware estimate still remembers it (modulo slow decay).
    expect(forTimeout).toBeGreaterThan(SLOW * 0.9 ** 4 * 0.99);
    // End to end: the bound computed from it clears the honest slow mode.
    const timeoutMs = resolveTaskTimeoutMs({
      overrideMs: null,
      floorMs: 45 * 60_000,
      durationMs: forTimeout,
      headroomMultiplier: 2,
      quantumMs: 5 * 60_000,
      maxMs: 90 * 60_000,
    });
    expect(timeoutMs).toBeGreaterThan(SLOW);
    // Control: the same bound computed from the bare EWMA is the floor — the
    // exact coin-flip configuration this estimator exists to prevent.
    const ewmaTimeoutMs = resolveTaskTimeoutMs({
      overrideMs: null,
      floorMs: 45 * 60_000,
      durationMs: ewma,
      headroomMultiplier: 2,
      quantumMs: 5 * 60_000,
      maxMs: 90 * 60_000,
    });
    expect(ewmaTimeoutMs).toBe(45 * 60_000);
  });

  it('timeoutDurationEstimate falls back to the EWMA for a legacy entry without peakMs', () => {
    const legacy = {
      version: emptyDurationHistory().version,
      tasks: { 'a :: test': { durationMs: 1234, samples: 3, updatedAt: 't0' } },
    };
    expect(timeoutDurationEstimate(legacy, 'a :: test')).toBe(1234);
    expect(timeoutDurationEstimate(legacy, 'missing')).toBeNull();
  });

  it('a merge over a legacy entry seeds the peak from its EWMA rather than zero', () => {
    const legacy = {
      version: emptyDurationHistory().version,
      tasks: { 'a :: test': { durationMs: 10_000, samples: 3, updatedAt: 't0' } },
    };
    const next = mergeDurationHistory(legacy, [{ key: 'a :: test', durationMs: 1000 }], 't1');
    // decayed EWMA seed (10000 * 0.9) beats the fast observation
    expect(next.tasks['a :: test'].peakMs).toBe(9000);
  });

  it('the recorded peak decays so a one-off outlier does not pin the bound forever', () => {
    let history = mergeDurationHistory(emptyDurationHistory(), [{ key: 'a :: test', durationMs: 100_000 }], 't1');
    for (let i = 0; i < 30; i += 1) {
      history = mergeDurationHistory(history, [{ key: 'a :: test', durationMs: 1000 }], `t${i + 2}`);
    }
    // 100000 * 0.9^30 ≈ 4240 — the outlier has decayed to the same order as
    // the observed durations instead of pinning the timeout at its own scale.
    expect(timeoutDurationEstimate(history, 'a :: test')).toBeLessThan(10_000);
  });

  it('atomically replaces a complete local file and leaves no temporary sibling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-task-history-test-'));
    const path = join(dir, 'history.json');
    try {
      const history = mergeDurationHistory(
        emptyDurationHistory(),
        [{ key: '@papercusp/web :: test', durationMs: 42 }],
        'now',
      );
      writeDurationHistoryAtomic(path, history, 'test-nonce');
      expect(readDurationHistory(path)).toEqual(history);
      expect(readdirSync(dir)).toEqual(['history.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // EI-20806073740910935: gate run 10 loaded EMPTY history while a valid,
  // populated file sat at the path — the bare catch{} swallowed whatever the
  // transient read failure was, every watchdog bound fell to its floor, and
  // the estimator fix above was inert for the entire ~55min run with zero
  // trace. A read failure that is NOT plain first-run ENOENT must say so.
  it('a non-ENOENT read failure returns empty AND reports itself on stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-task-history-test-'));
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // A DIRECTORY at the path makes readFileSync throw EISDIR — a stand-in
      // for the whole non-ENOENT class (EMFILE/EIO/EACCES) without flakiness.
      expect(readDurationHistory(dir)).toEqual(emptyDurationHistory());
      const written = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('READ FAILED');
      expect(written).toContain(dir);
      expect(written).toContain('EI-20806073740910935');
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a version-mismatched file returns empty AND reports the discard on stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-task-history-test-'));
    const path = join(dir, 'history.json');
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      writeFileSync(path, JSON.stringify({ version: 999, tasks: { 'a :: test': { durationMs: 5 } } }));
      expect(readDurationHistory(path)).toEqual(emptyDurationHistory());
      const written = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('DISCARDED');
      expect(written).toContain('version=999');
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('plain ENOENT (first run, no history yet) stays quiet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-task-history-test-'));
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(readDurationHistory(join(dir, 'never-written.json'))).toEqual(emptyDurationHistory());
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('operator-visible budget markers', () => {
  it('reports configured and observed ceilings separately', () => {
    const resolved = resolveTaskBudget(config);
    expect(formatTaskBudgetMarker(resolved)).toContain(
      'workerBudget=4 memoryBudgetMb=4096 workerMemoryMb=1024 effectiveWorkers=4 maxTasks=2',
    );
    expect(
      formatTaskBudgetObservedMarker({
        ...resolved,
        observedMaxWorkers: 4,
        observedMaxMemoryMb: 4096,
        observedMaxTasks: 2,
      }),
    ).toBe('AFFECTED_TESTS_SCHEDULER_OBSERVED maxWorkers=4 maxMemoryMb=4096 maxTasks=2');
  });

  // EI-20801764054303492 route (a). The admission fields are appended ONLY when a reader was
  // wired, so the legacy string above stays byte-identical for every caller that passes none —
  // the two assertions are a matched pair and must be read together.
  it('appends the admission terms only when a memory reader was wired', () => {
    const resolved = resolveTaskBudget(config);
    const observed = { ...resolved, observedMaxWorkers: 4, observedMaxMemoryMb: 4096, observedMaxTasks: 2 };

    expect(formatTaskBudgetObservedMarker({ ...observed, memoryReadings: null })).toBe(
      'AFFECTED_TESTS_SCHEDULER_OBSERVED maxWorkers=4 maxMemoryMb=4096 maxTasks=2',
    );
    expect(
      formatTaskBudgetObservedMarker({
        ...observed,
        memoryReadings: 3,
        admissionClamps: 2,
        minAdmittedWorkers: 1,
      }),
    ).toBe(
      'AFFECTED_TESTS_SCHEDULER_OBSERVED maxWorkers=4 maxMemoryMb=4096 maxTasks=2 ' +
        'memReadings=3 clamps=2 minAdmittedWorkers=1',
    );
  });

  // EI-20801764054303492 step 3. The gate log used to record the RESOLVED concurrency but not the
  // REASON for it, so "is the memory rail engaging?" could only be answered by re-deriving the
  // whole chain from source — which is how the rail stayed inert unnoticed. These assert the two
  // readings are distinguishable in the log, because that distinction is the whole point: under
  // 'ceiling' a ceiling raise would take effect, under 'memory' it would change nothing.
  it('names the CEILING as the binding term when memory has headroom to spare', () => {
    const resolved = resolveTaskBudget({ ...config, memoryBudgetMb: 64 * 1024 });
    expect(resolved.boundBy).toBe('ceiling');
    expect(resolved.memoryWorkerBudget).toBeGreaterThan(resolved.workerBudget);
    expect(resolved.effectiveWorkerBudget).toBe(resolved.workerBudget);
    expect(formatTaskBudgetMarker(resolved)).toContain('memoryWorkers=64 boundBy=ceiling');
  });

  it('names MEMORY as the binding term when the host measurement holds concurrency down', () => {
    // 2 workers' worth of memory against a 4-worker ceiling: the min() binds on memory.
    const resolved = resolveTaskBudget({ ...config, memoryBudgetMb: 2 * 1024 });
    expect(resolved.boundBy).toBe('memory');
    expect(resolved.effectiveWorkerBudget).toBe(2);
    expect(resolved.effectiveWorkerBudget).toBeLessThan(resolved.workerBudget);
    expect(formatTaskBudgetMarker(resolved)).toContain('memoryWorkers=2 boundBy=memory');
  });

  it('reports the host measurement when one was taken, and omits it when there was none', () => {
    const resolved = resolveTaskBudget(config);
    // Present: the operator can compare what the box had against what was admitted.
    expect(formatTaskBudgetMarker({ ...resolved, memAvailableMb: 51_200 })).toContain('memAvailableMb=51200');
    // Absent: "no measurement" is meaningful and must NOT be rendered as 0/null, which would
    // read as "the box had no memory" — the exact misreading this marker exists to prevent.
    expect(formatTaskBudgetMarker(resolved)).not.toContain('memAvailableMb');
    expect(formatTaskBudgetMarker({ ...resolved, memAvailableMb: null })).not.toContain('memAvailableMb');
  });

  it('derives the binding term for a caller that supplies no boundBy (older/hand-built stats)', () => {
    expect(formatTaskBudgetMarker({ ...resolveTaskBudget(config), boundBy: undefined })).toContain('boundBy=ceiling');
  });
});

describe('affected-tests scheduler wiring', () => {
  it('awaits the initial budgeted pool and preserves allocation-specific Vitest ceilings', () => {
    expect(AFFECTED_TESTS_SRC).toContain('initialPool = await runBudgetedTaskShards(TASK_CONTEXT_SHARD_PLAN');
    for (const variable of ['VITEST_MAX_WORKERS', 'VITEST_MAX_FORKS', 'VITEST_MAX_THREADS']) {
      expect(AFFECTED_TESTS_SRC).toContain(`${variable}: String(allocation.workers)`);
    }
  });

  // EI-20801764054303492 route (a), the SAME inert-rail class WI-39472 records below — and it
  // already happened once to this very feature: `admissibleWorkersForMemory` sat exported, tested
  // and CALLED BY NOTHING for hours, which every unit test above passes cleanly through. A clamp
  // nothing wires is not a clamp. Pinned at BOTH call sites and matched structurally (a bounded
  // gap after the call opening) rather than as a bare substring, so the prose explaining the
  // wiring cannot satisfy the assertion on its own.
  it('passes the live memory reader to BOTH budgeted pools, so the admission clamp is not inert', () => {
    expect(AFFECTED_TESTS_SRC).toMatch(
      /initialPool = await runBudgetedTaskShards\(TASK_CONTEXT_SHARD_PLAN[\s\S]{0,500}?\n\s*readMemAvailableMb,/,
    );
    expect(AFFECTED_TESTS_SRC).toMatch(
      /const retryPool = await runBudgetedTasks\(\[scheduled\.task\][\s\S]{0,500}?\n\s*readMemAvailableMb,/,
    );
  });

  // WI-39472: the memory rail was INERT for as long as this default was
  // `SCHEDULER_WORKER_BUDGET * SCHEDULER_WORKER_MEMORY_MB` — that makes memoryWorkerBudget
  // identically equal to workerBudget, so resolveTaskBudget's Math.min can never bind. Nothing
  // failed loudly, which is exactly why it survived. Pin the wiring at the source, because a
  // behavioural test cannot see the difference on a host with plenty of free memory.
  it('measures the host for its memory budget instead of deriving it from the worker budget', () => {
    expect(AFFECTED_TESTS_SRC).toContain('memoryBudgetMb: resolveMemoryBudgetMb({');
    // EI-20801764054303492: the reading is hoisted to a const so the budget and the
    // operator-visible marker report the SAME measurement (two readFileSync calls would drift on
    // a busy box). The guard's INTENT is unchanged — "the host is measured, not derived" — so it
    // now pins the hoist plus its use, which is strictly more than the single call site it
    // replaced. Both halves are required: the const alone could be measured and then ignored.
    expect(AFFECTED_TESTS_SRC).toContain('const MEM_AVAILABLE_MB = readMemAvailableMb()');
    expect(AFFECTED_TESTS_SRC).toContain('memAvailableMb: MEM_AVAILABLE_MB');
    expect(AFFECTED_TESTS_SRC).toContain('taskCgroupMemoryMaxMb: TASK_CGROUP_MEMORY_MAX_MB');
    expect(AFFECTED_TESTS_SRC).toContain('const TASK_CGROUP_PIDS_MAX = readTaskCgroupPidsMax()');
    expect(AFFECTED_TESTS_SRC).toContain('taskCgroupPidsMax: TASK_CGROUP_PIDS_MAX');
    expect(AFFECTED_TESTS_SRC).toContain('const TASK_CGROUP_PIDS_EVENTS_MAX_START = readTaskCgroupPidsEventMax()');
    expect(AFFECTED_TESTS_SRC).toContain('AFFECTED_TESTS_REFUSAL kind=pids-exhausted');
    // MemAvailable, never MemFree/os.freemem() — the latter two ignore reclaimable page cache and
    // read catastrophically low on a long-lived box. (Asserted on the READ, not on the absence of
    // the string "os.freemem()" anywhere in the file: the prose explaining WHY we avoid it names
    // it, so an absence assertion would be defeated by its own rationale.)
    expect(AFFECTED_TESTS_SRC).toContain('MemAvailable:');
    expect(AFFECTED_TESTS_SRC).not.toMatch(/memAvailableMb:\s*(?:os\.)?freemem\(/);
    // THE REGRESSION: the self-referential default that made the clamp unable to bind. Matched
    // STRUCTURALLY (as the value of memoryBudgetMb) rather than as a bare substring — a bare
    // substring assertion is defeated by the comment that explains the regression, which is a
    // trap this very test fell into twice while being written.
    expect(AFFECTED_TESTS_SRC).not.toMatch(
      /memoryBudgetMb:[\s\S]{0,120}?SCHEDULER_WORKER_BUDGET \* SCHEDULER_WORKER_MEMORY_MB/,
    );
  });

  it('drains the initial pool before reporting and reuses the same scheduler for retries', () => {
    // WI-1490656 wrapped this await in a try/catch so an admission-starvation throw becomes a
    // reported refusal rather than an uncaught top-level rejection, so the declaration is now
    // `let initialPool;` above the assignment.
    const pool = AFFECTED_TESTS_SRC.indexOf('initialPool = await runBudgetedTaskShards(TASK_CONTEXT_SHARD_PLAN');
    const reporting = AFFECTED_TESTS_SRC.indexOf('for (const scheduled of initialPool.results) {');
    const retry = AFFECTED_TESTS_SRC.indexOf('const retryPool = await runBudgetedTasks([scheduled.task]');
    expect(pool).toBeGreaterThan(-1);
    expect(reporting).toBeGreaterThan(pool);
    expect(retry).toBeGreaterThan(reporting);
  });
});

/**
 * WI-1490656 — the shared-admission QUEUE, and why a queued run reads as a wedge.
 *
 * Measured on this box: green-checkpoint run pid 952836 (candidate 6da5cd4db218) ran 16 of
 * its 126 planned tasks, then produced nothing for 1h42m while holding the gate's SINGLETON
 * run lock, so every later fire recorded `skipped-locked`. It was filed as
 * "affected-tests.mjs --related hangs". It was not hanging. `/proc` showed the textbook
 * wedge signature — parked in `ep_poll`, ZERO child processes, a run log frozen mid-run —
 * which is ALSO exactly what a caller queued on `papercusp-test-process-admission` looks
 * like, because a queued caller does nothing by definition.
 *
 * A live instance was captured while writing this: pid 4094320 held the mutex 50 min while
 * pid 911055 sat queued 23.5 min, its log frozen at the exact line before the acquisition.
 *
 * Two independent defects made that indistinguishable and unbounded:
 *
 *  1. INVISIBLE. The queued notice went to `console.error`, which cannot reach the
 *     affected-tests RUN LOG (written by the runner's own `logLine`) — the very file the
 *     run's BEGIN line tells a triager to grep. Confirmed by census: zero occurrences of
 *     `AFFECTED_TESTS_ADMISSION_QUEUED` across all 993 run logs present on the box. It also
 *     fired exactly ONCE, at t≈0, so even on stderr a multi-hour queue said nothing after
 *     the first instant.
 *
 *  2. UNBOUNDED. `SHARED_TEST_PROCESS_ADMISSION_TIMEOUT_MS` (4h) bounds ONE acquisition, and
 *     `runBudgetedTaskShards` acquires once PER SHARD. The 126-task run planned 16 shards, so
 *     the bound everyone reads as "4h" was really 16 × 4h.
 */
describe('shared test-process admission queue (WI-1490656)', () => {
  const heldTasks = ['a'];
  const trivialRun = {
    ...config,
    runTask: async () => 'ok',
  };

  it('re-announces while still queued instead of falling silent after the first notice', async () => {
    const release = deferred<void>();
    const acquired = deferred<void>();
    const holder = withFsMutex(
      'wi1490656-reannounce',
      async () => {
        acquired.resolve();
        await release.promise;
      },
      { timeoutMs: 10_000, staleMs: 60_000, retryMs: 5 },
    );
    await acquired.promise;

    const notices: number[] = [];
    const waiter = withFsMutex('wi1490656-reannounce', async () => 'done', {
      timeoutMs: 10_000,
      staleMs: 60_000,
      retryMs: 5,
      waitingNoticeIntervalMs: 25,
      onWaiting: ({ elapsedMs }: { elapsedMs: number }) => notices.push(elapsedMs),
    });

    // THE POINT: a caller that keeps waiting keeps SAYING SO. Before this fix `onWaiting`
    // was one-shot, so this could never exceed 1 no matter how long the wait ran.
    await until(() => notices.length >= 3, 're-announced waiting notices');
    release.resolve();
    await holder;
    await waiter;

    expect(notices.length).toBeGreaterThanOrEqual(3);
    // Each notice reports a strictly later elapsed time — they are real re-announcements on
    // a cadence, not the same event delivered repeatedly.
    for (let i = 1; i < notices.length; i += 1) {
      expect(notices[i]).toBeGreaterThan(notices[i - 1]);
    }
  }, 20_000);

  it('CONTROL: without an interval the notice stays one-shot, so the count above is caused by the interval', async () => {
    const release = deferred<void>();
    const acquired = deferred<void>();
    const holder = withFsMutex(
      'wi1490656-oneshot',
      async () => {
        acquired.resolve();
        await release.promise;
      },
      { timeoutMs: 10_000, staleMs: 60_000, retryMs: 5 },
    );
    await acquired.promise;

    let notices = 0;
    const waiter = withFsMutex('wi1490656-oneshot', async () => 'done', {
      timeoutMs: 10_000,
      staleMs: 60_000,
      retryMs: 5,
      onWaiting: () => {
        notices += 1;
      },
    });
    await until(() => notices >= 1, 'first waiting notice');
    // Give it far more poll cycles than the re-announcing case needed for 3 notices.
    await new Promise<void>((done) => setTimeout(done, 200));
    expect(notices).toBe(1);

    release.resolve();
    await holder;
    await waiter;
  }, 20_000);

  it('routes the queued notice to an injected sink so it can reach the run log', async () => {
    const release = deferred<void>();
    const acquired = deferred<void>();
    const holder = withFsMutex(
      // Hold the lane the scheduler will ACTUALLY queue on: under the gate
      // (PC_HEAVY_RELEASE_GATE=1) that is the `-release-gate` lane (WI-1746759), so a
      // hard-coded shared name never contends and the queued notice never arrives.
      admissionMutexName(),
      async () => {
        acquired.resolve();
        await release.promise;
      },
      { timeoutMs: 10_000, staleMs: 60_000, retryMs: 5 },
    );
    await acquired.promise;

    const lines: string[] = [];
    const running = runBudgetedTasks(heldTasks, {
      ...trivialRun,
      onAdmissionNotice: (line: string) => lines.push(line),
    });
    await until(() => lines.length >= 1, 'queued notice on the injected sink');
    release.resolve();
    await holder;
    await running;

    // The marker a triager greps for, carried on the sink the runner wires to `errSync`
    // (stderr AND the run log) rather than `console.error` (stderr only).
    expect(lines[0]).toContain('AFFECTED_TESTS_ADMISSION_QUEUED');
    expect(lines[0]).toContain('not a hang');
  }, 20_000);

  it('spends ONE queue budget across all shards instead of restarting it per shard', async () => {
    const release = deferred<void>();
    const acquired = deferred<void>();
    const holder = withFsMutex(
      // Hold the lane the scheduler will ACTUALLY queue on: under the gate
      // (PC_HEAVY_RELEASE_GATE=1) that is the `-release-gate` lane (WI-1746759), so a
      // hard-coded shared name never contends and the queued notice never arrives.
      admissionMutexName(),
      async () => {
        acquired.resolve();
        await release.promise;
      },
      { timeoutMs: 10_000, staleMs: 60_000, retryMs: 5 },
    );
    await acquired.promise;

    const admissions: Array<{ waitedMs: number; budgetMs: number }> = [];
    // `near-tree-wide` is the class that actually splits — and the class the 126-task run
    // that lost the gate was assigned (`class=near-tree-wide reason=root-manifest-or-config`,
    // 126 tasks ⇒ 16 shards). A scoped plan is one shard and cannot exhibit the defect.
    const plan = planAffectedTaskShards(['s1', 's2'], {
      blastRadius: { kind: 'near-tree-wide', reason: 'root-manifest-or-config', triggerPaths: [] },
      taskKey: (task: string) => task,
      maxTasksPerShard: 1,
    });
    expect(plan.shards.length).toBe(2);

    const queuedNotices: string[] = [];
    const running = runBudgetedTaskShards(plan, {
      ...trivialRun,
      admissionRunBudgetMs: 8_000,
      onAdmissionNotice: (line: string) => queuedNotices.push(line),
      onAdmissionAcquired: (info: { waitedMs: number; budgetMs: number }) =>
        admissions.push(info),
    });

    // Hold long enough that shard 1's queue time is unambiguously larger than timer noise,
    // so the budget it consumes is measurable rather than a rounding artefact.
    await until(() => queuedNotices.length >= 1, 'shard 1 queued');
    await new Promise<void>((done) => setTimeout(done, 300));
    release.resolve();
    await holder;
    await running;

    expect(admissions.length).toBe(2);
    const [first, second] = admissions;
    expect(first.budgetMs).toBe(8_000);
    expect(first.waitedMs).toBeGreaterThanOrEqual(250);
    // THE POINT: shard 2 inherits what shard 1 LEFT, not a fresh full budget. Before this
    // fix every shard got the full value, so an N-shard run's real admission bound was
    // N × the timeout — 16 × 4h for the 126-task run that lost the gate.
    expect(second.budgetMs).toBeLessThan(first.budgetMs);
    expect(second.budgetMs).toBeCloseTo(8_000 - first.waitedMs, -2);
  }, 20_000);

  it('records the GRANT instant, so a holder\'s hold duration is measurable rather than inferred from attempt-start', async () => {
    // `startedAt` is stamped when a caller begins TRYING, so it silently includes that
    // caller's own queue wait. Reading it as "held since" overstates the hold by exactly the
    // holder's wait — an error made and retracted during this investigation. `acquiredAt` is
    // written at the mkdir that IS the grant, so the two are distinguishable.
    const lockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR as string;
    const blocker = deferred<void>();
    const blocking = deferred<void>();
    const first = withFsMutex(
      'wi1490656-acquiredat',
      async () => {
        blocking.resolve();
        await blocker.promise;
      },
      { timeoutMs: 10_000, staleMs: 60_000, retryMs: 5 },
    );
    await blocking.promise;

    // Second caller starts NOW and is forced to queue, so its attempt-start precedes its grant
    // by a measurable margin.
    const attemptStartedAt = Date.now();
    let ownerJson: Record<string, string> = {};
    const second = withFsMutex(
      'wi1490656-acquiredat',
      async () => {
        ownerJson = JSON.parse(
          readFileSync(join(lockRoot, 'wi1490656-acquiredat.lock', 'owner.json'), 'utf8'),
        );
      },
      { timeoutMs: 10_000, staleMs: 60_000, retryMs: 5 },
    );
    await new Promise<void>((done) => setTimeout(done, 300));
    blocker.resolve();
    await first;
    await second;

    expect(ownerJson.startedAt).toBeTruthy();
    expect(ownerJson.acquiredAt).toBeTruthy();
    const startedAt = Date.parse(ownerJson.startedAt);
    const acquiredAt = Date.parse(ownerJson.acquiredAt);
    // THE POINT: they are DIFFERENT, and the gap is this caller's queue wait. Before this
    // field existed there was no way to tell a long-held lock from a long-queued one.
    expect(acquiredAt).toBeGreaterThan(startedAt);
    expect(startedAt).toBeGreaterThanOrEqual(attemptStartedAt - 50);
    expect(acquiredAt - startedAt).toBeGreaterThanOrEqual(200);
  }, 20_000);

  it('classifies a REAL admission timeout, so exhausting the budget cannot become a lost run', async () => {
    const release = deferred<void>();
    const acquired = deferred<void>();
    const holder = withFsMutex(
      // Hold the lane the scheduler will ACTUALLY queue on: under the gate
      // (PC_HEAVY_RELEASE_GATE=1) that is the `-release-gate` lane (WI-1746759), so a
      // hard-coded shared name never contends and the queued notice never arrives.
      admissionMutexName(),
      async () => {
        acquired.resolve();
        await release.promise;
      },
      { timeoutMs: 10_000, staleMs: 60_000, retryMs: 5 },
    );
    await acquired.promise;

    // Provoke the ACTUAL error object the runner will have to classify — not a hand-written
    // lookalike. If someone rewords the throw in fs-mutex.mjs, this fails here instead of
    // silently restoring "gate run exits with no verdict".
    let thrown: unknown;
    try {
      await runBudgetedTasks(heldTasks, {
        ...trivialRun,
        admissionTimeoutMs: 60,
        // Keep the notice off `console.error` — vitest-fail-on-console treats the default
        // sink as a test failure, which is itself a small demonstration of why the sink had
        // to become injectable.
        onAdmissionNotice: () => {},
      });
    } catch (error) {
      thrown = error;
    }
    release.resolve();
    await holder;

    expect(thrown).toBeInstanceOf(Error);
    expect(isSharedAdmissionTimeout(thrown)).toBe(true);

    // CONTROLS: a real test failure and a timeout on a DIFFERENT mutex must not be swallowed
    // as admission starvation — misclassifying either way loses a genuine red.
    expect(isSharedAdmissionTimeout(new Error('boom: 3 tests failed'))).toBe(false);
    expect(
      isSharedAdmissionTimeout(
        new Error('Timed out after 60ms waiting for fs-mutex "some-other-lock" (/tmp/x)'),
      ),
    ).toBe(false);
    expect(isSharedAdmissionTimeout(undefined)).toBe(false);
  }, 20_000);

  it('the runner turns that classification into an attributable refusal instead of an uncaught rejection', () => {
    // `runBudgetedTaskShards` is awaited at module top level. An uncaught rejection there
    // kills the process with no AFFECTED_TESTS_RESULT line — the exact "exit-without-verdict"
    // shape the gate records as a lost run — so bounding the wait is only safe if the throw
    // is caught and reported. Pinned structurally: the catch must re-throw anything that is
    // NOT admission starvation, so this can never become a blanket swallow.
    expect(AFFECTED_TESTS_SRC).toContain('AFFECTED_TESTS_REFUSAL kind=admission-starved');
    expect(AFFECTED_TESTS_SRC).toContain('status=refused reason=admission-starved');
    expect(AFFECTED_TESTS_SRC).toMatch(/if\s*\(!isSharedAdmissionTimeout\(error\)\)\s*throw error;/);
    // And the queue notices must be routed to `errSync` (stderr AND the run log), not left on
    // the scheduler's `console.error` default, which never reaches RUN_LOG_PATH.
    expect(AFFECTED_TESTS_SRC).toMatch(/onAdmissionNotice:\s*\(line\)\s*=>\s*errSync\(line\)/);
  });

  describe('WI-1746759: the release gate rides its own admission lane', () => {
    // Why a separate lane at all: `runBudgetedTasks` takes the mutex ONCE PER SHARD, so on the
    // shared lane the gate re-queues per shard and each re-entry lands behind whoever arrived
    // meanwhile. Measured 2026-08-31T12:23:04Z — shards=17, 46 queued notices, ZERO acquisitions
    // in 45 min, then death on the run budget with 130/130 tasks undetermined. Not a red: a
    // non-verdict.

    it('routes the gate off the shared lane, keyed on PC_HEAVY_RELEASE_GATE', () => {
      expect(admissionMutexName({ PC_HEAVY_RELEASE_GATE: '1' })).toBe(
        'papercusp-test-process-admission-release-gate',
      );
      expect(admissionMutexName({})).toBe('papercusp-test-process-admission');
      // pc-heavy.sh tests the literal "1", not truthiness — an empty or odd value is NOT the gate.
      expect(admissionMutexName({ PC_HEAVY_RELEASE_GATE: '' })).toBe(
        'papercusp-test-process-admission',
      );
      expect(admissionMutexName({ PC_HEAVY_RELEASE_GATE: '0' })).toBe(
        'papercusp-test-process-admission',
      );
    });

    it('does NOT let GREEN_CHECKPOINT=1 buy a private lane — the hole pc-heavy.sh already closed once', () => {
      // The load-bearing control. GREEN_CHECKPOINT is double-duty: it also drives
      // `describe.skipIf` in load-/network-sensitive tests, so agents legitimately export it BY
      // HAND to reproduce the gate's skip-set. pc-heavy.sh records that keying ADMISSION off it
      // once meant `GREEN_CHECKPOINT=1 npm run test:affected` bypassed that semaphore at nice 0,
      // "re-opening the very hole this wrapper closes". Keying a private LANE off it would repeat
      // the incident one layer down: any agent exporting the marker would silently leave the
      // queue its peers are waiting in. Only the dedicated key may do this.
      expect(admissionMutexName({ GREEN_CHECKPOINT: '1' })).toBe(
        'papercusp-test-process-admission',
      );
      // ...and the gate itself carries BOTH, so the dedicated key still decides.
      expect(admissionMutexName({ GREEN_CHECKPOINT: '1', PC_HEAVY_RELEASE_GATE: '1' })).toBe(
        'papercusp-test-process-admission-release-gate',
      );
    });

    it('keeps a GATE-lane timeout classified as admission starvation, not a lost run', () => {
      // WI-1490656's failure mode, reachable only through this change. `isSharedAdmissionTimeout`
      // classifies by `message.includes(<shared name>)`, and `affected-tests.mjs` re-throws
      // anything it rejects. So an unrelated gate-lane name would make the gate's OWN timeouts
      // re-throw instead of becoming `status=refused reason=admission-starved` — no
      // AFFECTED_TESTS_RESULT line, and green-checkpoint records a lost run. Deriving the gate
      // name from the shared one makes the containment structural rather than coincidental.
      const gateLane = admissionMutexName({ PC_HEAVY_RELEASE_GATE: '1' });
      expect(gateLane).toContain(admissionMutexName({}));
      expect(
        isSharedAdmissionTimeout(
          new Error(
            `Timed out after 2700000ms waiting for fs-mutex "${gateLane}" ` +
              `(/tmp/pcv/fs-mutex-locks/${gateLane}.lock)`,
          ),
        ),
      ).toBe(true);
      // CONTROL: the containment must not be so loose that a genuinely unrelated lock passes.
      expect(
        isSharedAdmissionTimeout(
          new Error('Timed out after 60ms waiting for fs-mutex "papercusp-something-else" (/tmp/x)'),
        ),
      ).toBe(false);
    });

    it('is wired into the acquisition itself, not just exported', () => {
      // Structural pin: the export existing proves nothing if `runBudgetedTasks` still passes the
      // bare constant. Guards the one-line regression that would silently restore the shared lane.
      expect(SCHEDULER_SRC).toMatch(/withFsMutex\(\s*(?:\/\/[^\n]*\n\s*)*admissionMutexName\(\),/);
      // And the gate name must stay DERIVED, so it cannot drift out of that containment.
      expect(SCHEDULER_SRC).toMatch(
        /RELEASE_GATE_ADMISSION_MUTEX\s*=\s*`\$\{SHARED_TEST_PROCESS_ADMISSION_MUTEX\}-release-gate`/,
      );
    });
  });
});

// EI-21917992245424964: a blocked peer could see THAT a holder existed and never whether it
// was worth waiting for, so the safe default was always to wait. The notice is the surface
// that has to answer it — it is re-announced on a 60s cadence for the whole queue wait, and
// it previously spent all of that repeating four identity fields as pretty-printed JSON.
describe('formatAdmissionHolder', () => {
  it('renders a declared holder as one line carrying scope and a bounded ETA', () => {
    const line = formatAdmissionHolder(
      JSON.stringify({
        pid: 4242,
        host: 'somehost',
        name: 'papercusp-test-process-admission',
        acquiredAt: '2026-08-31T12:00:00.000Z',
        intent: { scope: 'git-status', tasks: 90, etaMinSec: 1560, etaFromTasks: '61/90' },
      }),
      Date.parse('2026-08-31T12:02:00.000Z'),
    );

    expect(line).toContain('pid=4242');
    expect(line).toContain('held=120s');
    expect(line).toContain('scope=git-status');
    expect(line).toContain('etaMinSec=1560');
    // The ratio must travel WITH the ETA: a lower bound read as an estimate is the
    // confidently-wrong number this whole record exists to stop producing.
    expect(line).toContain('etaFromTasks=61/90');
    expect(line).not.toContain('\n');
  });

  it('says intent=undeclared rather than staying silent, so "did not say" cannot read as "cheap"', () => {
    const line = formatAdmissionHolder(
      JSON.stringify({
        pid: 7,
        host: 'somehost',
        startedAt: '2026-08-31T12:00:00.000Z',
        name: 'papercusp-test-process-admission',
      }),
    );

    expect(line).toContain('intent=undeclared');
  });

  it('falls open to the raw text instead of throwing while a caller is already blocked', () => {
    expect(formatAdmissionHolder('not json at all')).toBe('not json at all');
    expect(formatAdmissionHolder(undefined)).toBe('');
    // A JSON array parses but is not an owner record; it must not be mined for fields.
    expect(formatAdmissionHolder('[1,2,3]')).toBe('[1,2,3]');
  });

  it('is what the queued notice actually calls, not a helper nothing reaches', () => {
    expect(SCHEDULER_SRC).toMatch(/holder: \$\{formatAdmissionHolder\(owner\)\}/);
    expect(SCHEDULER_SRC).toMatch(/intent:\s*options\?\.admissionIntent/);
  });

  it('is fed by affected-tests, which derives its declaration instead of hand-maintaining it', () => {
    // Derived from the run's own settled facts — the acquisition sits below the derivation
    // boundary, so these are known by then and cannot drift from what the run really does.
    expect(AFFECTED_TESTS_SRC).toMatch(/admissionIntent,/);
    expect(AFFECTED_TESTS_SRC).toContain('scope: derivationSource');
    expect(AFFECTED_TESTS_SRC).toContain('etaFromTasks');
  });
});
