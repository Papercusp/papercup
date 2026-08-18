import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  durationEstimate,
  emptyDurationHistory,
  formatTaskBudgetMarker,
  formatTaskBudgetObservedMarker,
  mergeDurationHistory,
  readDurationHistory,
  resolveGlobalWorkerBudget,
  resolveTaskBudget,
  resolveWorkerMemoryMb,
  runBudgetedTasks,
  timeoutDurationEstimate,
  writeDurationHistoryAtomic,
} from '../../../../scripts/lib/budgeted-task-scheduler.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS policy module, no declaration file.
import { resolveTaskTimeoutMs } from '../../../../scripts/lib/batch-watchdog.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS_SRC = readFileSync(resolve(REPO_ROOT, 'scripts/affected-tests.mjs'), 'utf8');

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

    await Promise.resolve();
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
    expect(result.results.map((entry: { task: { id: string } }) => entry.task.id)).toEqual([
      'long',
      'medium',
      'short',
    ]);
    expect(result.results.map((entry: { value: string }) => entry.value)).toEqual([
      'long-result',
      'medium-result',
      'short-result',
    ]);
    expect(result.stats.observedMaxWorkers).toBe(4);
    expect(result.stats.observedMaxMemoryMb).toBe(4096);
    expect(result.stats.observedMaxTasks).toBe(2);
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

    await Promise.resolve();
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
});

describe('affected-tests scheduler wiring', () => {
  it('awaits the initial budgeted pool and preserves allocation-specific Vitest ceilings', () => {
    expect(AFFECTED_TESTS_SRC).toContain(
      'const initialPool = await runBudgetedTasks(taskContexts',
    );
    for (const variable of ['VITEST_MAX_WORKERS', 'VITEST_MAX_FORKS', 'VITEST_MAX_THREADS']) {
      expect(AFFECTED_TESTS_SRC).toContain(`${variable}: String(allocation.workers)`);
    }
  });

  it('drains the initial pool before reporting and reuses the same scheduler for retries', () => {
    const pool = AFFECTED_TESTS_SRC.indexOf(
      'const initialPool = await runBudgetedTasks(taskContexts',
    );
    const reporting = AFFECTED_TESTS_SRC.indexOf('for (const scheduled of initialPool.results) {');
    const retry = AFFECTED_TESTS_SRC.indexOf(
      'const retryPool = await runBudgetedTasks([scheduled.task]',
    );
    expect(pool).toBeGreaterThan(-1);
    expect(reporting).toBeGreaterThan(pool);
    expect(retry).toBeGreaterThan(reporting);
  });
});
