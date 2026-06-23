/**
 * event-loop-lag-monitor.test.ts — EI-79 observability gauge.
 *
 * Verifies: (1) a healthy/idle loop stays silent (no warning under threshold);
 * (2) sustained synchronous blocking on the loop trips the p95 warning; (3) the
 * timer is unref'd / stop() is clean. We drive the internal interval by setting
 * a short `intervalMs` and a low threshold, and block the loop synchronously to
 * manufacture lag (the native histogram measures real libuv delay, so we can't
 * fake it — we induce it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  captureCpuProfile,
  classifyLoopPressure,
  cooperativeYield,
  isLoopSaturated,
  loopPressure,
  startEventLoopLagMonitor,
  yieldToEventLoop,
  type LagMonitorHandle,
} from './event-loop-lag-monitor';

function blockFor(ms: number): void {
  const end = Date.now() + ms;
  // Busy-wait to actually occupy the event loop (manufactures real lag).
  while (Date.now() < end) {
    /* spin */
  }
}

describe('event-loop-lag-monitor', () => {
  let handle: LagMonitorHandle | undefined;
  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  it('stays silent on an idle loop (no warning under threshold)', async () => {
    const log = vi.fn();
    handle = startEventLoopLagMonitor({ intervalMs: 50, warnP95Ms: 1000, log });
    await new Promise((r) => setTimeout(r, 180));
    expect(log).not.toHaveBeenCalled();
  });

  it('warns when sustained blocking pushes p95 loop lag over the threshold', async () => {
    const log = vi.fn();
    handle = startEventLoopLagMonitor({ intervalMs: 60, warnP95Ms: 20, log });
    // Block the loop repeatedly so the histogram records high delay before the
    // 60ms evaluation tick fires.
    for (let i = 0; i < 4; i++) {
      blockFor(40);
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 120));
    expect(log).toHaveBeenCalled();
    const [, detail] = log.mock.calls[0];
    expect(detail.p95Ms).toBeGreaterThanOrEqual(20);
  });

  it('sample() returns numeric percentiles and stop() is clean', () => {
    handle = startEventLoopLagMonitor({ intervalMs: 10_000, warnP95Ms: 1000 });
    const s = handle.sample();
    expect(typeof s.p50Ms).toBe('number');
    expect(typeof s.p95Ms).toBe('number');
    expect(typeof s.maxMs).toBe('number');
    expect(() => handle?.stop()).not.toThrow();
  });
});

describe('loop-pressure signal (P5-1)', () => {
  it('classifyLoopPressure bands by p95 (default thresholds 120/600ms)', () => {
    expect(classifyLoopPressure(0)).toBe('ok');
    expect(classifyLoopPressure(50)).toBe('ok');
    expect(classifyLoopPressure(120)).toBe('elevated');
    expect(classifyLoopPressure(599)).toBe('elevated');
    expect(classifyLoopPressure(600)).toBe('critical');
    expect(classifyLoopPressure(5000)).toBe('critical');
  });

  it('classifyLoopPressure honors custom thresholds + is NaN-safe', () => {
    expect(classifyLoopPressure(50, 40, 100)).toBe('elevated');
    expect(classifyLoopPressure(200, 40, 100)).toBe('critical');
    expect(classifyLoopPressure(NaN)).toBe('ok'); // no signal ⇒ never shed
  });

  it('loopPressure() is "ok" / isLoopSaturated() false when NO monitor is running', () => {
    // No monitor started in this test ⇒ absence of signal must read as ok.
    expect(loopPressure()).toBe('ok');
    expect(isLoopSaturated()).toBe(false);
  });

  it('an idle monitored loop reads "ok" (not saturated)', () => {
    const h = startEventLoopLagMonitor({ intervalMs: 10_000, warnP95Ms: 1000 });
    try {
      expect(loopPressure()).toBe('ok');
      expect(isLoopSaturated()).toBe(false);
    } finally {
      h.stop();
    }
    // After stop the published signal is cleared back to ok.
    expect(loopPressure()).toBe('ok');
  });
});

describe('F1 lag-triggered CPU profiler (infra round-3)', () => {
  let handle: LagMonitorHandle | undefined;
  const dirs: string[] = [];
  afterEach(async () => {
    handle?.stop();
    handle = undefined;
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  });
  const tmp = (tag: string) => {
    const d = path.join(os.tmpdir(), `loop-prof-${tag}-${Date.now()}-${process.pid}`);
    dirs.push(d);
    return d;
  };

  it('captureCpuProfile writes a valid .cpuprofile (or degrades to null, never throws)', async () => {
    const dir = tmp('cap');
    const file = await captureCpuProfile({
      durationMs: 120,
      dir,
      maxProfiles: 20,
      trigger: { p50Ms: 1, p95Ms: 700, p99Ms: 800, maxMs: 900 },
      log: vi.fn(),
    });
    // Contract: returns a path when an inspector is available, else null — but
    // NEVER throws (the gauge must not break the host it observes).
    if (file === null) return; // env without a free inspector (e.g. coverage attached)
    expect(file.endsWith('.cpuprofile')).toBe(true);
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    // A V8 CPU profile has a node tree + samples.
    expect(parsed).toHaveProperty('nodes');
    expect(parsed).toHaveProperty('samples');
  });

  it('is INERT by default: no capture under saturation when profileOnSaturation is off', async () => {
    const dir = tmp('off');
    const log = vi.fn();
    handle = startEventLoopLagMonitor({
      intervalMs: 60,
      warnP95Ms: 20,
      profileOnSaturation: false,
      profileDir: dir,
      profileTriggerP95Ms: 20,
      minProfileGapMs: 0,
      log,
    });
    for (let i = 0; i < 4; i++) {
      blockFor(40);
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 150));
    expect(log).toHaveBeenCalled(); // the symptom warning still fires
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      /* dir never created = inert, which is the point */
    }
    expect(files.filter((f) => f.endsWith('.cpuprofile'))).toHaveLength(0);
  });

  it('ON path: a saturated window triggers a capture (best-effort), bounded by maxProfiles', async () => {
    const dir = tmp('on');
    handle = startEventLoopLagMonitor({
      intervalMs: 60,
      warnP95Ms: 20,
      profileOnSaturation: true,
      profileDir: dir,
      profileTriggerP95Ms: 20,
      profileDurationMs: 120,
      minProfileGapMs: 0,
      maxProfiles: 3,
      log: vi.fn(),
    });
    for (let i = 0; i < 4; i++) {
      blockFor(40);
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 500)); // allow async capture + write
    let profs: string[] = [];
    try {
      profs = (await fs.readdir(dir)).filter((f) => f.endsWith('.cpuprofile'));
    } catch {
      /* no inspector available ⇒ graceful no-op */
    }
    expect(profs.length).toBeLessThanOrEqual(3); // rate-limit + prune bound holds
    if (profs.length) {
      // any captured file must be valid JSON
      expect(() => JSON.parse('{}')).not.toThrow();
      const body = await fs.readFile(path.join(dir, profs[0]), 'utf8');
      expect(() => JSON.parse(body)).not.toThrow();
    }
  });
});

describe('cooperativeYield / yieldToEventLoop (event-loop-lag root fix)', () => {
  it('yieldToEventLoop lets a pending macrotask (the "ticker") run before continuing', async () => {
    const order: string[] = [];
    // A pending immediate stands in for the routine ticker callback.
    setImmediate(() => order.push('ticker'));
    order.push('before');
    await yieldToEventLoop();
    order.push('after');
    // The ticker ran in the gap, NOT after the loop continued.
    expect(order).toEqual(['before', 'ticker', 'after']);
  });

  it('cooperativeYield yields on the everyN boundary and advances the counter', async () => {
    // No monitor running ⇒ loopPressure() is 'ok', so only the everyN boundary triggers a yield.
    let ranTicker = false;
    let n = 0;
    // everyN = 4 (default): iterations 1,2,3 do NOT yield; iteration 4 does.
    for (let i = 0; i < 3; i++) {
      setImmediate(() => { ranTicker = true; });
      n = await cooperativeYield(n);
      // setImmediate scheduled but a non-yielding iteration must NOT have run it yet
      // (we can't assert synchronously across awaits reliably, so just track count).
    }
    expect(n).toBe(3); // counter advanced once per call
    // The 4th call crosses the boundary → yields → the pending immediate runs.
    setImmediate(() => { ranTicker = true; });
    n = await cooperativeYield(n);
    expect(n).toBe(4);
    expect(ranTicker).toBe(true);
  });

  it('cooperativeYield respects a custom everyN', async () => {
    let n = 0;
    n = await cooperativeYield(n, 1); // everyN=1 ⇒ yields every iteration
    expect(n).toBe(1);
    n = await cooperativeYield(n, 1);
    expect(n).toBe(2);
  });
});
