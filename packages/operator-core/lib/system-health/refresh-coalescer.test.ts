import { describe, expect, it } from 'vitest';
import { PanelRefreshCoalescer, type RefreshScheduler } from './refresh-coalescer';

/**
 * A manual scheduler: timers fire only when the test says so, so these tests
 * are deterministic and never sleep.
 */
function manualScheduler() {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const sched: RefreshScheduler = {
    setTimer: (fn, ms) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (h) => {
      pending.delete(h as number);
    },
  };
  return {
    sched,
    pendingCount: () => pending.size,
    /** Fire every currently-pending timer once (timers scheduled by them stay pending). */
    fireAll: () => {
      const now = [...pending.entries()];
      pending.clear();
      for (const [, t] of now) t.fn();
    },
  };
}

/** A run() that records its invocations and resolves on demand. */
function recorder() {
  let calls = 0;
  return { run: async () => { calls += 1; }, calls: () => calls };
}

describe('PanelRefreshCoalescer', () => {
  it('runs the LEADING edge immediately — a single write still refreshes promptly', async () => {
    const m = manualScheduler();
    const c = new PanelRefreshCoalescer({ scheduler: m.sched });
    const r = recorder();

    await c.request('ws', 'observations', r.run);

    expect(r.calls()).toBe(1);
  });

  it('coalesces a BURST into exactly one trailing run', async () => {
    const m = manualScheduler();
    const c = new PanelRefreshCoalescer({ scheduler: m.sched });
    const r = recorder();

    // 20 writes arriving inside one window (the shape this exists to fix).
    for (let i = 0; i < 20; i++) await c.request('ws', 'observations', r.run);
    expect(r.calls()).toBe(1); // leading only — the other 19 are coalesced

    m.fireAll(); // window end -> one trailing run
    await Promise.resolve();
    expect(r.calls()).toBe(2);
  });

  it('CONTROL: the same 20 writes WITHOUT coalescing run 20 times', async () => {
    // Calibration for the test above. Without this control, "2 runs" could be
    // produced by a run() that simply never fires, and the coalescing assertion
    // would pass vacuously. 20-vs-2 is the property under test.
    const r = recorder();
    for (let i = 0; i < 20; i++) await r.run();
    expect(r.calls()).toBe(20);
  });

  it('a QUIET window closes, so the next request is a fresh leading edge', async () => {
    const m = manualScheduler();
    const c = new PanelRefreshCoalescer({ scheduler: m.sched });
    const r = recorder();

    await c.request('ws', 'observations', r.run);
    expect(r.calls()).toBe(1);

    m.fireAll(); // quiet window -> closes, no trailing run
    await Promise.resolve();
    expect(r.calls()).toBe(1);
    expect(m.pendingCount()).toBe(0); // window closed, no timer left running

    await c.request('ws', 'observations', r.run); // fresh leading edge
    expect(r.calls()).toBe(2);
  });

  it('keeps the window OPEN while traffic continues, then closes when it stops', async () => {
    const m = manualScheduler();
    const c = new PanelRefreshCoalescer({ scheduler: m.sched });
    const r = recorder();

    await c.request('ws', 'observations', r.run); // leading (1)
    await c.request('ws', 'observations', r.run); // coalesced
    m.fireAll();                                   // trailing (2), window re-armed
    await Promise.resolve();
    expect(r.calls()).toBe(2);
    expect(m.pendingCount()).toBe(1);

    m.fireAll();                                   // quiet -> close, no run
    await Promise.resolve();
    expect(r.calls()).toBe(2);
    expect(m.pendingCount()).toBe(0);
  });

  it('keys independently by (workspace, panel)', async () => {
    const m = manualScheduler();
    const c = new PanelRefreshCoalescer({ scheduler: m.sched });
    const a = recorder(), b = recorder(), d = recorder();

    await c.request('ws1', 'observations', a.run);
    await c.request('ws1', 'improvements', b.run); // different panel
    await c.request('ws2', 'observations', d.run); // different workspace

    // Each key gets its own leading edge — one panel's burst never suppresses another's.
    expect([a.calls(), b.calls(), d.calls()]).toEqual([1, 1, 1]);
  });

  it('never rejects when run() throws — the write path must not fail', async () => {
    const m = manualScheduler();
    const c = new PanelRefreshCoalescer({ scheduler: m.sched });

    await expect(c.request('ws', 'observations', async () => {
      throw new Error('collector blew up');
    })).resolves.toBeUndefined();

    await expect(c.request('ws2', 'observations', () => {
      throw new Error('synchronous blow-up');
    })).resolves.toBeUndefined();
  });

  it('does not run two refreshes of the same panel CONCURRENTLY', async () => {
    const m = manualScheduler();
    const c = new PanelRefreshCoalescer({ scheduler: m.sched });
    let running = 0, maxConcurrent = 0, calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const run = async () => {
      calls += 1; running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await gate;
      running -= 1;
    };

    const leading = c.request('ws', 'observations', run); // starts, blocks on gate
    expect(calls).toBe(1);

    m.fireAll();              // trailing edge fires while the leading run is STILL in flight
    await Promise.resolve();
    expect(maxConcurrent).toBe(1); // must not overlap — that would double the cost

    release();
    await leading;
  });
});
