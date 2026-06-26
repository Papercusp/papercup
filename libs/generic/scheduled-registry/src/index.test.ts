import { afterEach, describe, expect, it } from 'vitest';
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
