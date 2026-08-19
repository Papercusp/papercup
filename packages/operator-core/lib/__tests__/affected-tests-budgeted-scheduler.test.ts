import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  resolveMemoryBudgetMb,
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

  it('clamps admission DOWN when the reading drops mid-run, and never widens it', async () => {
    // 4 workers x 1024MB needs >=5462MB at a 0.25 reserve; 3000MB affords 2, 2000MB affords 1.
    const reader = readerFrom([3000, 2000]);
    const { widths, stats } = await widthsFor({ readMemAvailableMb: reader.read });

    // Admission #0 is deliberately unmeasured — the startup reading that sized the budget is
    // still fresh there — so it keeps the full width. Every LATER admission re-measures.
    expect(widths[0]).toBe(4);
    expect(widths.slice(1)).toEqual([2, 1]);
    expect(reader.callCount()).toBe(2);
    expect(stats.memoryReadings).toBe(2);
    expect(stats.admissionClamps).toBe(2);
    expect(stats.minAdmittedWorkers).toBe(1);
    expect(stats.lastMemAvailableMb).toBe(2000);
  });

  it('never lets a clamped run exceed the peak of the same run unclamped', async () => {
    const unclamped = await widthsFor({});
    const clamped = await widthsFor({ readMemAvailableMb: readerFrom([2000]).read });

    expect(clamped.stats.observedMaxWorkers).toBeLessThanOrEqual(
      unclamped.stats.observedMaxWorkers,
    );
    expect(clamped.stats.observedMaxMemoryMb).toBeLessThanOrEqual(
      unclamped.stats.observedMaxMemoryMb,
    );
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

  it('holds the floor of one worker at a zero reading', async () => {
    const { widths, stats } = await widthsFor({ readMemAvailableMb: () => 0 });

    // Refusing admission outright would deadlock a run already under memory pressure.
    expect(widths.slice(1).every((w) => w === 1)).toBe(true);
    expect(stats.minAdmittedWorkers).toBe(1);
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

  it('binds on available memory, so a loaded host admits fewer workers than its ceiling allows', () => {
    // 4096 MiB available, 25% reserved => 3072 usable => 3 tokens, BELOW the 8-worker ceiling.
    const budget = resolveMemoryBudgetMb({ ...base, memAvailableMb: 4096 });
    expect(budget).toBe(3072);
    expect(resolveTaskBudget({ ...base, memoryBudgetMb: budget, maxConcurrentTasks: 8, reserveWorkers: 1 }))
      .toMatchObject({ memoryWorkerBudget: 3, effectiveWorkerBudget: 3, primaryWorkers: 2 });
  });

  it('NEVER widens the budget past the worker ceiling, however much memory is free', () => {
    // A 1 TiB host must not admit more than the 8-worker ceiling can pay for.
    expect(resolveMemoryBudgetMb({ ...base, memAvailableMb: 1024 * 1024 })).toBe(8 * 1024);
  });

  it('floors at one worker so a memory-starved host degrades to serial instead of throwing', () => {
    // 100 MiB available would otherwise buy ZERO tokens, which resolveTaskBudget rejects outright.
    expect(resolveMemoryBudgetMb({ ...base, memAvailableMb: 100 })).toBe(1024);
    expect(() =>
      resolveTaskBudget({ ...base, memoryBudgetMb: 1024, maxConcurrentTasks: 8, reserveWorkers: 1 }),
    ).not.toThrow();
  });

  it('lets an explicit AFFECTED_GLOBAL_MEMORY_MB win over the measured host', () => {
    expect(
      resolveMemoryBudgetMb({ ...base, affectedGlobalMemoryMb: '2048', memAvailableMb: 999_999 }),
    ).toBe(2048);
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
    expect(formatTaskBudgetMarker({ ...resolved, memAvailableMb: 51_200 })).toContain(
      'memAvailableMb=51200',
    );
    // Absent: "no measurement" is meaningful and must NOT be rendered as 0/null, which would
    // read as "the box had no memory" — the exact misreading this marker exists to prevent.
    expect(formatTaskBudgetMarker(resolved)).not.toContain('memAvailableMb');
    expect(formatTaskBudgetMarker({ ...resolved, memAvailableMb: null })).not.toContain(
      'memAvailableMb',
    );
  });

  it('derives the binding term for a caller that supplies no boundBy (older/hand-built stats)', () => {
    expect(
      formatTaskBudgetMarker({ ...resolveTaskBudget(config), boundBy: undefined }),
    ).toContain('boundBy=ceiling');
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

  // EI-20801764054303492 route (a), the SAME inert-rail class WI-39472 records below — and it
  // already happened once to this very feature: `admissibleWorkersForMemory` sat exported, tested
  // and CALLED BY NOTHING for hours, which every unit test above passes cleanly through. A clamp
  // nothing wires is not a clamp. Pinned at BOTH call sites and matched structurally (a bounded
  // gap after the call opening) rather than as a bare substring, so the prose explaining the
  // wiring cannot satisfy the assertion on its own.
  it('passes the live memory reader to BOTH budgeted pools, so the admission clamp is not inert', () => {
    expect(AFFECTED_TESTS_SRC).toMatch(
      /const initialPool = await runBudgetedTasks\(taskContexts[\s\S]{0,500}?\n\s*readMemAvailableMb,/,
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
