import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listModuleDuplications,
  resetPinnedModuleStateForTest,
} from '@papercusp/module-singleton';
import {
  configureScheduledRegistry,
  getManaged,
  listManaged,
  managedCount,
  managedSetInterval,
  resetScheduledRegistry,
  stopAllManaged,
  type TimerHandle,
} from './index';

/** Flush microtasks (the tick's Promise chain) + one macrotask. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

interface CapturedInterval {
  cb: () => void;
  ms: number;
  handle: TimerHandle;
  cleared: boolean;
}

function harness() {
  const intervals: CapturedInterval[] = [];
  const timeouts: { cb: () => void; ms: number }[] = [];
  let now = 1_000_000;
  let shed = false;
  configureScheduledRegistry({
    setIntervalImpl: (cb, ms) => {
      const handle: TimerHandle = { unref: () => undefined };
      intervals.push({ cb, ms, handle, cleared: false });
      return handle;
    },
    clearIntervalImpl: (h) => {
      const e = intervals.find((i) => i.handle === h);
      if (e) e.cleared = true;
    },
    setTimeoutImpl: (cb, ms) => {
      timeouts.push({ cb, ms });
      return { unref: () => undefined };
    },
    now: () => now,
    shouldShed: () => shed,
    log: () => undefined,
  });
  return {
    intervals,
    timeouts,
    setNow: (n: number) => {
      now = n;
    },
    setShed: (s: boolean) => {
      shed = s;
    },
    /** Synchronously invoke a captured interval cb, then flush its async chain. */
    fire: async (i = 0): Promise<void> => {
      intervals[i].cb();
      await flush();
    },
  };
}

afterEach(() => resetScheduledRegistry());

describe('managedSetInterval / listManaged', () => {
  it('registers a named, listable entry with category + interval + armedAt', () => {
    const h = harness();
    h.setNow(5_000);
    managedSetInterval('system-health', 30_000, () => undefined, { category: 'global-sweep', shed: true });

    expect(managedCount()).toBe(1);
    const [e] = listManaged();
    expect(e).toMatchObject({
      name: 'system-health',
      category: 'global-sweep',
      intervalMs: 30_000,
      armedAt: 5_000,
      lastFireAt: null,
      fires: 0,
      shed: true,
    });
    expect(h.intervals).toHaveLength(1);
    expect(h.intervals[0].ms).toBe(30_000);
  });

  it('keeps the default recurring backend inert under Vitest unless a test opts in', () => {
    // The deterministic harness above intentionally injects a fake backend, so it remains
    // active in Vitest. This case covers the production/default backend that must not leak a
    // process-wide callback across factory-mocked modules in an unrelated test.
    resetScheduledRegistry();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    try {
      const skipped = managedSetInterval('vitest-inert', 1_000, () => undefined, { category: 'watchdog' });
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(managedCount()).toBe(0);
      skipped.stop();

      const allowed = managedSetInterval('vitest-allowed', 1_000, () => undefined, {
        category: 'watchdog',
        allowInTest: true,
      });
      expect(setIntervalSpy).toHaveBeenCalledOnce();
      allowed.stop();
      expect(clearIntervalSpy).toHaveBeenCalledOnce();
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      resetScheduledRegistry();
    }
  });

  it('a fire stamps lastFireAt + increments fires + clears lastError', async () => {
    const h = harness();
    let calls = 0;
    managedSetInterval('sweep', 1000, () => {
      calls += 1;
    }, { category: 'global-sweep' });

    h.setNow(2_000);
    await h.fire();
    expect(calls).toBe(1);
    expect(getManaged('sweep')).toMatchObject({ lastFireAt: 2_000, fires: 1, lastError: null });

    h.setNow(3_000);
    await h.fire();
    expect(getManaged('sweep')).toMatchObject({ lastFireAt: 3_000, fires: 2 });
  });

  it('a throwing tick records lastError but never crashes; the next tick recovers', async () => {
    const h = harness();
    let fail = true;
    managedSetInterval('flaky', 1000, () => {
      if (fail) throw new Error('boom');
    }, { category: 'global-sweep' });

    await h.fire();
    expect(getManaged('flaky')).toMatchObject({ fires: 1, lastError: 'boom' });

    fail = false;
    await h.fire();
    expect(getManaged('flaky')).toMatchObject({ fires: 2, lastError: null });
  });

  it('re-entrancy guard: a slow tick never piles up a second concurrent run', async () => {
    const h = harness();
    let resolveFn!: () => void;
    managedSetInterval('slow', 1000, () => new Promise<void>((r) => {
      resolveFn = r;
    }), { category: 'global-sweep' });

    h.intervals[0].cb(); // start tick 1
    await Promise.resolve(); // let the chain call fn() (captures resolveFn) + set running
    expect(getManaged('slow')!.running).toBe(true);

    h.intervals[0].cb(); // tick 2 while tick 1 in flight → skipped
    await flush();
    expect(getManaged('slow')!.fires).toBe(0); // tick 1 still pending, tick 2 skipped

    resolveFn(); // finish tick 1
    await flush();
    expect(getManaged('slow')!.fires).toBe(1); // only tick 1 counted
    expect(getManaged('slow')!.running).toBe(false);
  });

  it('shed: a shed:true timer skips a cycle when shouldShed() is true; a non-shed timer does not', async () => {
    const h = harness();
    let shedCalls = 0;
    let alwaysCalls = 0;
    managedSetInterval('heavy', 1000, () => {
      shedCalls += 1;
    }, { category: 'global-sweep', shed: true });
    managedSetInterval('light', 1000, () => {
      alwaysCalls += 1;
    }, { category: 'global-sweep' });

    h.setShed(true);
    await h.fire(0); // heavy — shed
    await h.fire(1); // light — runs
    expect(shedCalls).toBe(0);
    expect(alwaysCalls).toBe(1);

    h.setShed(false);
    await h.fire(0); // heavy — now runs
    expect(shedCalls).toBe(1);
  });

  it('fireOnArm schedules an immediate setTimeout(0) tick', async () => {
    const h = harness();
    let calls = 0;
    managedSetInterval('healer', 600_000, () => {
      calls += 1;
    }, { category: 'global-sweep', fireOnArm: true });

    expect(h.timeouts).toHaveLength(1);
    expect(h.timeouts[0].ms).toBe(0);
    h.timeouts[0].cb(); // simulate the immediate fire
    await flush();
    expect(calls).toBe(1);
  });

  it('stop() clears the underlying timer and deregisters from the inventory', () => {
    const h = harness();
    const handle = managedSetInterval('x', 1000, () => undefined, { category: 'watchdog' });
    expect(managedCount()).toBe(1);
    handle.stop();
    expect(managedCount()).toBe(0);
    expect(getManaged('x')).toBeUndefined();
    expect(h.intervals[0].cleared).toBe(true);
    handle.stop(); // idempotent
    expect(managedCount()).toBe(0);
  });

  it('re-registering a name stops the previous timer (no duplicate, no leak)', () => {
    const h = harness();
    managedSetInterval('dup', 1000, () => undefined, { category: 'cache' });
    managedSetInterval('dup', 2000, () => undefined, { category: 'cache' });
    expect(managedCount()).toBe(1);
    expect(getManaged('dup')!.intervalMs).toBe(2000);
    expect(h.intervals[0].cleared).toBe(true); // the first timer was cleared
    expect(h.intervals[1].cleared).toBe(false);
  });

  it('listManaged returns sorted snapshots; stopAllManaged clears everything', () => {
    harness();
    managedSetInterval('zeta', 1000, () => undefined, { category: 'global-sweep' });
    managedSetInterval('alpha', 1000, () => undefined, { category: 'lifecycle' });
    expect(listManaged().map((e) => e.name)).toEqual(['alpha', 'zeta']);
    // snapshot — mutating the returned array/objects doesn't affect the registry
    listManaged()[0].fires = 99;
    expect(getManaged('alpha')!.fires).toBe(0);
    stopAllManaged();
    expect(managedCount()).toBe(0);
  });

  it('instanced: many timers share ONE name without colliding, and aggregate in listManaged', () => {
    const h = harness();
    const a = managedSetInterval('ws-keepalive', 20_000, () => undefined, { category: 'lifecycle', instanced: true });
    managedSetInterval('ws-keepalive', 20_000, () => undefined, { category: 'lifecycle', instanced: true });
    const c = managedSetInterval('ws-keepalive', 20_000, () => undefined, { category: 'lifecycle', instanced: true });

    // 3 raw timers armed (NO collision — none stopped the prior)
    expect(h.intervals.length).toBe(3);
    expect(managedCount()).toBe(3);
    // ...but ONE aggregated inventory row carrying the live instance count
    const rows = listManaged();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'ws-keepalive', instanced: true, instances: 3 });
    expect(getManaged('ws-keepalive')).toMatchObject({ instances: 3 });

    // stopping one instance drops the count; the row stays until the last instance stops
    a.stop();
    expect(managedCount()).toBe(2);
    expect(listManaged()[0].instances).toBe(2);
    c.stop();
    expect(listManaged()[0].instances).toBe(1);
  });

  it('instanced aggregation rolls up fires + most-recent lastFire across instances', async () => {
    const h = harness();
    managedSetInterval('hb', 1000, () => undefined, { category: 'lifecycle', instanced: true });
    managedSetInterval('hb', 1000, () => undefined, { category: 'lifecycle', instanced: true });
    h.setNow(5_000);
    await h.fire(0); // instance 0 fires
    h.setNow(8_000);
    await h.fire(1); // instance 1 fires later
    const row = getManaged('hb')!;
    expect(row.instances).toBe(2);
    expect(row.fires).toBe(2); // summed
    expect(row.lastFireAt).toBe(8_000); // most-recent across instances
  });
});

/**
 * P-011 (stop-discarded-dedup-and-audit-server-polling-2026-07-26): the D-004 push-don't-poll
 * `classification` a call site declares must actually reach the INVENTORY — that is the whole
 * point of the field. `lint:timer-classification` enforces that new call sites DECLARE one;
 * nothing below it proved the declared value is stored, defaulted, or aggregated correctly.
 */
describe('timer classification (P-011 / D-004)', () => {
  it('records a declared classification on the entry and surfaces it in the inventory', () => {
    harness();
    managedSetInterval('system-health', 30_000, () => undefined, {
      category: 'global-sweep',
      classification: 'violation',
    });

    expect(listManaged()[0].classification).toBe('violation');
    expect(getManaged('system-health')?.classification).toBe('violation');
  });

  it('defaults to null when the call site omits one (a site the shrink-only lint BASELINE still grandfathers)', () => {
    harness();
    managedSetInterval('legacy-sweep', 1000, () => undefined, { category: 'global-sweep' });

    // null, NOT undefined: the inventory column is always present, so a grandfathered
    // site reads as "not yet classified" rather than as a missing field.
    expect(getManaged('legacy-sweep')?.classification).toBeNull();
  });

  it.each(['must-sample', 'timeout-reaper', 'violation'] as const)(
    'round-trips the %s verdict unchanged',
    (verdict) => {
      harness();
      managedSetInterval(`t-${verdict}`, 1000, () => undefined, {
        category: 'global-sweep',
        classification: verdict,
      });
      expect(getManaged(`t-${verdict}`)?.classification).toBe(verdict);
    },
  );

  it('instanced aggregation adopts a later instance classification when the first declared none', () => {
    harness();
    // Per-connection timers are armed from one call site, but an UNCLASSIFIED arm must not
    // mask a classified sibling — otherwise the inventory row reports "unclassified" for a
    // timer that was in fact classified, and the audit under-counts.
    managedSetInterval('ws-keepalive', 20_000, () => undefined, { category: 'lifecycle', instanced: true });
    managedSetInterval('ws-keepalive', 20_000, () => undefined, {
      category: 'lifecycle',
      instanced: true,
      classification: 'must-sample',
    });

    const row = getManaged('ws-keepalive')!;
    expect(row.instances).toBe(2);
    expect(row.classification).toBe('must-sample');
  });

  it('instanced aggregation is FIRST-WINS: a later differing classification does not overwrite one already set', () => {
    harness();
    managedSetInterval('mixed', 20_000, () => undefined, {
      category: 'lifecycle',
      instanced: true,
      classification: 'must-sample',
    });
    managedSetInterval('mixed', 20_000, () => undefined, {
      category: 'lifecycle',
      instanced: true,
      classification: 'violation',
    });

    // Pinning the documented intent of the `g.classification == null` guard in listManaged():
    // instances of ONE name are the same call site, so a disagreement is a code bug, not a
    // state to merge. First-wins keeps the row stable rather than order-dependent-looking;
    // if divergent classifications per name ever become legitimate, THIS test is the one to
    // revisit deliberately.
    expect(getManaged('mixed')?.classification).toBe('must-sample');
  });
});

describe('dual module instance shares ONE inventory (EI-19451658870832332)', () => {
  // `vi.resetModules()` drops the module registry, so the dynamic import below RE-EVALUATES
  // index.ts and hands back a genuinely SEPARATE module instance. That is the production
  // hazard reproduced in-process: the host entry runs under tsx (CJS preflight + ESM loader),
  // importers reach this package through both bare-specifier and relative paths, and
  // node_modules/@papercusp/* are symlinks — any of which yields two module records.
  //
  // Falsifiable by construction: with the state held in module scope (as it was before
  // EI-19451658870832332) the re-evaluated instance starts with an EMPTY Map, so every
  // expectation below fails. It measured live as dbos-executor-reaper reaping every 2 minutes
  // inside bg-host while absent from that same process's own /api/internal/managed-timers.

  it('CONTROL: vi.resetModules() really does re-evaluate — module-scoped state comes back EMPTY', async () => {
    // Calibration, not a feature test. If this ever fails, resetModules() has stopped
    // producing a second instance and EVERY assertion in this describe block below is
    // passing vacuously — fix this before trusting them.
    const control = await import('./module-scoped-control.fixture');
    control.marks.push('first-instance');
    expect(control.marks).toEqual(['first-instance']);

    vi.resetModules();
    const controlAgain = await import('./module-scoped-control.fixture');

    expect(controlAgain.marks).toEqual([]);
    expect(controlAgain.marks).not.toBe(control.marks);
  });

  it('a timer armed in the FIRST instance is visible to a second, freshly-evaluated instance', async () => {
    harness();
    managedSetInterval('dual-instance-probe', 1000, () => undefined, { category: 'watchdog' });
    expect(listManaged().map((e) => e.name)).toContain('dual-instance-probe');

    vi.resetModules();
    const second = await import('./index');

    expect(second.listManaged().map((e) => e.name)).toContain('dual-instance-probe');
    expect(second.managedCount()).toBe(managedCount());
    expect(second.getManaged('dual-instance-probe')?.intervalMs).toBe(1000);
  });

  it('is symmetric — a timer armed in the SECOND instance is visible to the first', async () => {
    harness();
    vi.resetModules();
    const second = await import('./index');

    second.managedSetInterval('armed-in-second', 2000, () => undefined, { category: 'cache' });

    expect(listManaged().map((e) => e.name)).toContain('armed-in-second');
    expect(getManaged('armed-in-second')?.category).toBe('cache');
  });

  it('shares the CONFIGURED seams, so the second instance cannot silently run unshedded', async () => {
    // The second-order half of the same bug: `configureScheduledRegistry` writes to the same
    // state, so a hidden instance must not fall back to default seams (real setInterval, no
    // host tick-load-shed). Asserted via the fake setIntervalImpl installed by harness() on
    // the FIRST instance — an unshared config would arm a REAL timer and capture nothing.
    const h = harness();
    const before = h.intervals.length;

    vi.resetModules();
    const second = await import('./index');
    second.managedSetInterval('seam-probe', 3000, () => undefined, { category: 'watchdog' });

    expect(h.intervals.length).toBe(before + 1);
    expect(h.intervals[before].ms).toBe(3000);
  });

  // --- recurrence guard (EI-19463700807328229) -------------------------------
  // Pinning fixed the split but HID it: once both records share one state
  // object, nothing distinguishes one record from two. These assert the module
  // now reports its own duplication, so a re-split is caught by the inventory
  // instead of costing another multi-session investigation.

  /**
   * Start these assertions from a realm with NO pinned state.
   *
   * Earlier tests in this file re-evaluate the module on purpose, and the
   * evaluation count is cumulative across the whole suite by design — so each
   * count assertion below has to establish its own baseline or it measures the
   * suite's history instead of its own case.
   *
   * `resetPinnedModuleStateForTest` is the primitive's own test seam. Reaching
   * past it to `delete globalThis[Symbol.for(...)]` (as this file did while the
   * pin was hand-rolled here) would silently stop resetting anything the day the
   * key moved — which is exactly what happened when this module adopted
   * `@papercusp/module-singleton`: the deletes kept succeeding, cleared nothing,
   * and the counts read cumulative.
   */
  const freshRealm = () => {
    vi.resetModules();
    resetPinnedModuleStateForTest();
  };

  it('reports exactly one module evaluation, and no warning, when healthy', async () => {
    // Fresh realm for this assertion: earlier tests in this file deliberately
    // re-evaluate the module, so the count is cumulative across the suite.
    freshRealm();

    const fresh = await import('./index');

    expect(fresh.moduleEvaluationCount()).toBe(1);
    expect(fresh.moduleDuplicationWarning()).toBeNull();
  });

  it('counts a SECOND module record and warns — the recurrence signal', async () => {
    freshRealm();

    const first = await import('./index');
    expect(first.moduleEvaluationCount()).toBe(1);

    vi.resetModules();
    const second = await import('./index');

    // Both module records agree, because the counter lives in the pinned state.
    expect(second.moduleEvaluationCount()).toBe(2);
    expect(first.moduleEvaluationCount()).toBe(2);

    const warning = second.moduleDuplicationWarning();
    expect(warning).toContain('SPLIT MODULE SINGLETON');
    expect(warning).toContain('2x');
    // Must say the inventory is still trustworthy — the fix holds; it is the
    // PACKAGING that regressed. Reading this as "the timer list is wrong" would
    // send the next reader down the wrong path.
    expect(warning).toMatch(/packaging fault/i);
  });

  it('keeps the counter in the pinned state, so it cannot itself split', async () => {
    freshRealm();

    await import('./index');
    vi.resetModules();
    await import('./index');
    vi.resetModules();
    const third = await import('./index');

    // A module-scoped counter would read 1 here (fresh record); the pinned one reads 3.
    expect(third.moduleEvaluationCount()).toBe(3);
  });

  it('surfaces a split in the REALM-WIDE duplication report, not only its own accessor', async () => {
    // The point of pinning through @papercusp/module-singleton rather than
    // hand-rolling it here (EI-19463700807328229).
    //
    // While the pin was local, `moduleEvaluationCount()` on THIS module was the
    // only way to learn it had split: `listModuleDuplications()` — the central
    // report a host health check reads — knew nothing about it. That is the
    // original bug's own shape recreated one level up: the surface responsible
    // for reporting duplication would have been blind to the single module known
    // to duplicate in production, and would have answered a confident, empty
    // "no duplications".
    freshRealm();
    await import('./index');

    // Baseline: one evaluation is not a duplication, so the report stays empty.
    expect(listModuleDuplications().map((d) => d.key)).not.toContain(
      '@papercusp/scheduled-registry.state',
    );

    vi.resetModules();
    await import('./index');

    const reported = listModuleDuplications().find(
      (d) => d.key === '@papercusp/scheduled-registry.state',
    );
    expect(reported).toBeDefined();
    expect(reported?.evaluations).toBe(2);
  });
});

describe('the Vitest inertness guard distinguishes REAL timers from FAKE ones (WI-40841)', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetScheduledRegistry();
  });

  // The guard added for EI-21209553211440005 keeps the DEFAULT backend inert under Vitest so a
  // wall-clock callback cannot fire into another test's factory mocks. Its condition ("no
  // injected setIntervalImpl") also catches `vi.useFakeTimers()`, which is a perfectly
  // deterministic seam — and that silently red-pinned every fake-timer test over a
  // managedSetInterval call site (116 non-test sites; ~34 test files red from 03:00Z).
  //
  // `defaultSetIntervalImpl` resolves `setInterval` at CALL time, so under fake timers the
  // default backend is ALREADY driven by the fake clock. Arming is therefore safe: the callback
  // belongs to the clock and is torn down with it, so it cannot outlive the test.
  it('ARMS and FIRES under vi.useFakeTimers() with no injected backend', async () => {
    resetScheduledRegistry(); // default (production) backend in play — nothing injected
    vi.useFakeTimers();

    const tick = vi.fn();
    const handle = managedSetInterval('wi-40841-fake-clock', 1_000, tick, {
      category: 'watchdog',
    });

    // The inert path returns a no-op handle and registers nothing at all.
    expect(managedCount()).toBe(1);
    expect(getManaged('wi-40841-fake-clock')).toBeDefined();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(tick).toHaveBeenCalledTimes(3);

    handle.stop();
  });

  // The control for the ORIGINAL defect (EI-21209553211440005): with genuinely REAL timers the
  // default backend must still be inert, or that unhandled-rejection class returns. If this ever
  // fails, the fix above has been over-applied.
  // WI-10002781: a CHILD process a test spawns inherits VITEST=true through its env, but it is
  // not a Vitest worker: no test files, no factory mocks, and it needs its production intervals
  // (a perf peer's merge poll). When the guard keyed on the env var alone, those children ran
  // with every managed interval inert and substrate-compaction.integration.test.ts hung to its
  // 600s timeout. Simulate that child in-process: env var present, worker-state global absent.
  it('ARMS the default backend in a spawned child that inherited VITEST but is not a worker', () => {
    resetScheduledRegistry();
    expect(process.env.VITEST, 'precondition: the inherited env var is present').toBeTruthy();
    const g = globalThis as { __vitest_worker__?: unknown };
    expect(g.__vitest_worker__, 'precondition: this test runs inside a real worker').toBeDefined();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const savedWorkerState = g.__vitest_worker__;
    let handle: { stop(): void } | undefined;
    try {
      // Only the managedSetInterval call runs without the worker global; it is restored before
      // any assertion, since Vitest's own APIs read it.
      delete g.__vitest_worker__;
      try {
        handle = managedSetInterval('wi-10002781-spawned-child', 60_000, () => undefined, {
          category: 'watchdog',
        });
      } finally {
        g.__vitest_worker__ = savedWorkerState;
      }
      expect(setIntervalSpy).toHaveBeenCalledOnce();
      expect(managedCount()).toBe(1);
      expect(getManaged('wi-10002781-spawned-child')).toBeDefined();
    } finally {
      handle?.stop();
      setIntervalSpy.mockRestore();
      resetScheduledRegistry();
    }
  });

  it('still keeps the default backend inert when timers are REAL', () => {
    resetScheduledRegistry();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      const skipped = managedSetInterval('wi-40841-real-clock', 1_000, () => undefined, {
        category: 'watchdog',
      });
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(managedCount()).toBe(0);
      skipped.stop();
    } finally {
      setIntervalSpy.mockRestore();
      resetScheduledRegistry();
    }
  });
});
