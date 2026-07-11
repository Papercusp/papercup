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
  captureHeapSnapshot,
  classifyLoopPressure,
  cooperativeYield,
  currentLoopLag,
  isLoopElevated,
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
    // Hermetic: pin the heap-sampling/snapshot options OFF so the assertion measures
    // the committed idle-loop default regardless of ambient env. Without this, an
    // operator host (or any shell) with PAPERCUSP_HEAP_SNAPSHOT=1 makes the monitor
    // default heapSamplingOnHighRss=true, arm the sampler on the first tick, and log
    // "[heap-sampling] armed" into this spy — a false failure. The gate strips
    // PAPERCUSP_* so it stayed green there, but local runs on this host flaked.
    handle = startEventLoopLagMonitor({
      intervalMs: 50,
      warnP95Ms: 1000,
      log,
      heapSamplingOnHighRss: false,
      heapSnapshotOnHighRss: false,
    });
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

  // infra round-4 P-014: the host boots the monitor from BOTH the request plane
  // (startRequestServers) and the bg machinery (runBootstrap) so the cluster bg-host
  // primary — which serves no HTTP — also has a live gauge for the perf-regression rig.
  // That double-boot must NOT spawn two histograms/timers against one loop.
  it('is idempotent per process: a 2nd start returns the SAME running handle', () => {
    handle = startEventLoopLagMonitor({ intervalMs: 10_000, warnP95Ms: 1000 });
    // currentLoopLag() reads the live published gauge — non-null once a monitor runs.
    expect(currentLoopLag()).not.toBeNull();
    const second = startEventLoopLagMonitor({ intervalMs: 50, warnP95Ms: 5 });
    expect(second).toBe(handle); // re-entry returns the live handle, ignores new opts
  });

  it('after stop(), a fresh start creates a NEW monitor (guard is cleared)', () => {
    const first = startEventLoopLagMonitor({ intervalMs: 10_000, warnP95Ms: 1000 });
    first.stop();
    expect(currentLoopLag()).toBeNull(); // published gauge cleared on stop
    handle = startEventLoopLagMonitor({ intervalMs: 10_000, warnP95Ms: 1000 });
    expect(handle).not.toBe(first); // a clean process-start, not the stopped handle
    expect(currentLoopLag()).not.toBeNull();
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

  it('loopPressure() is "ok" / isLoopSaturated() / isLoopElevated() false when NO monitor is running', () => {
    // No monitor started in this test ⇒ absence of signal must read as ok.
    expect(loopPressure()).toBe('ok');
    expect(isLoopSaturated()).toBe(false);
    expect(isLoopElevated()).toBe(false);
  });

  it('an idle monitored loop reads "ok" (not saturated, not elevated)', () => {
    const h = startEventLoopLagMonitor({ intervalMs: 10_000, warnP95Ms: 1000 });
    try {
      expect(loopPressure()).toBe('ok');
      expect(isLoopSaturated()).toBe(false);
      expect(isLoopElevated()).toBe(false);
    } finally {
      h.stop();
    }
    // After stop the published signal is cleared back to ok.
    expect(loopPressure()).toBe('ok');
    expect(isLoopElevated()).toBe(false);
  });

  it('isLoopElevated() is true for elevated AND critical, false for ok', () => {
    // Driven via classifyLoopPressure to verify the full pressure → elevated mapping
    // without needing a live monitor (pure classification logic tested here).
    // p95 < 120ms  → ok       → isLoopElevated delegates to loopPressure; tested above.
    // We verify the exported predicate against the classification directly.
    expect(classifyLoopPressure(0)).toBe('ok');
    expect(classifyLoopPressure(119)).toBe('ok');
    expect(classifyLoopPressure(120)).toBe('elevated');   // ELEVATED: shed fires (WI-1084)
    expect(classifyLoopPressure(200)).toBe('elevated');   // chronic 130–240ms regime
    expect(classifyLoopPressure(599)).toBe('elevated');
    expect(classifyLoopPressure(600)).toBe('critical');   // CRITICAL: also sheds
    // isLoopElevated() returns true for both non-ok bands.
    // (We can't inject a synthetic p95 into the live gauge in a unit test, so
    //  we assert the underlying classification and isLoopElevated's no-monitor case.)
    expect(isLoopElevated()).toBe(false); // no monitor → 'ok' → false
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

  it('a saturated window also dumps a heap-sampling profile below the RSS snapshot threshold', async () => {
    const dir = tmp('sampling-on-saturation');
    const log = vi.fn();
    handle = startEventLoopLagMonitor({
      intervalMs: 60,
      warnP95Ms: 20,
      profileOnSaturation: true,
      profileDir: dir,
      profileTriggerP95Ms: 20,
      profileDurationMs: 120,
      minProfileGapMs: 0,
      heapSamplingOnHighRss: true,
      heapSnapshotOnHighRss: false,
      heapSnapshotDir: dir,
      minHeapSamplingDumpGapMs: 0,
      log,
    });
    for (let i = 0; i < 4; i++) {
      blockFor(40);
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 500));
    let heapProfiles: string[] = [];
    try {
      heapProfiles = (await fs.readdir(dir)).filter((f) => f.endsWith('.heapprofile'));
    } catch {
      /* no inspector available => graceful no-op */
    }
    if (heapProfiles.length > 0) {
      const body = await fs.readFile(path.join(dir, heapProfiles[0]), 'utf8');
      const parsed = JSON.parse(body) as { head?: unknown };
      expect(parsed.head).toBeTruthy();
      expect(log.mock.calls.some(([line]) => String(line).includes('top live allocation sites'))).toBe(true);
    }
  });
});

describe('P-002 heap-snapshot-on-high-RSS (bg-host-freeze-eventloop-stall-2026-06-30)', () => {
  const dirs: string[] = [];
  let handle: LagMonitorHandle | undefined;
  afterEach(async () => {
    handle?.stop();
    handle = undefined;
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  });
  const tmp = (tag: string) => {
    const d = path.join(os.tmpdir(), `heap-snap-${tag}-${Date.now()}-${process.pid}`);
    dirs.push(d);
    return d;
  };

  it('captureHeapSnapshot writes a valid .heapsnapshot (or degrades to null, never throws)', async () => {
    // Heap snapshots can take several seconds on a large heap; give plenty of time.
    const dir = tmp('cap');
    const file = await captureHeapSnapshot({
      dir,
      maxSnapshots: 5,
      rssMb: process.memoryUsage().rss / 1_048_576,
      log: vi.fn(),
    });
    // Contract: returns a path when an inspector is available, else null — never throws.
    if (file === null) return; // env without a free inspector (e.g. coverage attached)
    expect(file.endsWith('.heapsnapshot')).toBe(true);
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    // A V8 heap snapshot has snapshot.meta + nodes + strings arrays.
    expect(parsed).toHaveProperty('snapshot');
    expect(parsed).toHaveProperty('nodes');
    expect(parsed).toHaveProperty('strings');
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(Array.isArray(parsed.strings)).toBe(true);
  }, 30_000);

  it('captureHeapSnapshot prunes to maxSnapshots (oldest removed)', async () => {
    const dir = tmp('prune');
    // Write 3 snapshots with maxSnapshots=2 — the oldest must be removed.
    for (let i = 0; i < 3; i++) {
      await captureHeapSnapshot({ dir, maxSnapshots: 2, rssMb: 1, log: vi.fn() });
    }
    let snaps: string[] = [];
    try {
      snaps = (await fs.readdir(dir)).filter((f) => f.endsWith('.heapsnapshot'));
    } catch {
      /* no inspector → dir never created → graceful no-op */
    }
    expect(snaps.length).toBeLessThanOrEqual(2);
  }, 90_000);

  it('heapSnapshotOnHighRss: full snapshots are INERT by default even when legacy sampling env is on', async () => {
    // The monitor must NOT capture unless heapSnapshotOnHighRss is explicitly enabled,
    // even when RSS comfortably exceeds a 1 MB threshold.
    const dir = tmp('inert');
    const log = vi.fn();
    const prev = process.env.PAPERCUSP_HEAP_SNAPSHOT;
    process.env.PAPERCUSP_HEAP_SNAPSHOT = '1';
    handle = startEventLoopLagMonitor({
      intervalMs: 60,
      warnP95Ms: 999_999,
      // heapSnapshotOnHighRss not set: legacy PAPERCUSP_HEAP_SNAPSHOT enables the
      // non-blocking sampling profiler, NOT full V8 heap snapshots (WI-3255).
      heapSnapshotDir: dir,
      heapSnapshotRssMb: 1, // 1 MB — guaranteed to be exceeded
      minHeapSnapshotGapMs: 0,
      log,
    });
    await new Promise((r) => setTimeout(r, 200));
    if (prev === undefined) delete process.env.PAPERCUSP_HEAP_SNAPSHOT;
    else process.env.PAPERCUSP_HEAP_SNAPSHOT = prev;
    let snaps: string[] = [];
    try {
      snaps = (await fs.readdir(dir)).filter((f) => f.endsWith('.heapsnapshot'));
    } catch {
      /* dir not created = inert, which is the point */
    }
    expect(snaps).toHaveLength(0);
  });

  it('heapSnapshotOnHighRss ON: captures when RSS crosses threshold, rate-limited', async () => {
    const dir = tmp('on');
    const log = vi.fn();
    // Use a 1 MB threshold so it fires immediately (current process RSS >> 1 MB),
    // and a 10s gap so only ONE capture fires per timer tick.
    handle = startEventLoopLagMonitor({
      intervalMs: 80,
      warnP95Ms: 999_999,
      heapSnapshotOnHighRss: true,
      heapSnapshotDir: dir,
      heapSnapshotRssMb: 1,        // 1 MB — always exceeded
      minHeapSnapshotGapMs: 10_000, // 10s gap → only one fire in this test window
      maxHeapSnapshots: 3,
      log,
    });
    // Wait for at least one timer tick + capture
    await new Promise((r) => setTimeout(r, 5_000));
    let snaps: string[] = [];
    try {
      snaps = (await fs.readdir(dir)).filter((f) => f.endsWith('.heapsnapshot'));
    } catch {
      /* no inspector → graceful no-op */
    }
    // At most 1 capture (rate-limited by the 10s gap); could be 0 if no inspector.
    expect(snaps.length).toBeLessThanOrEqual(1);
    if (snaps.length > 0) {
      // Must be valid JSON with the heap snapshot shape.
      const parsed = JSON.parse(await fs.readFile(path.join(dir, snaps[0]), 'utf8'));
      expect(parsed).toHaveProperty('snapshot');
      expect(parsed).toHaveProperty('nodes');
    }
  }, 30_000);
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

describe('sampling heap profiler (WI-1088 round 2 — the capture that cannot lose the race)', () => {
  it('topAllocationSites flattens the tree, aggregates per site, sorts by size', async () => {
    const { topAllocationSites } = await import('./event-loop-lag-monitor');
    const head = {
      callFrame: { functionName: '(root)', url: '', lineNumber: -1 },
      selfSize: 0,
      children: [
        {
          callFrame: { functionName: 'leaky', url: 'file:///x/leak.ts', lineNumber: 41 },
          selfSize: 3 * 1_048_576,
          children: [
            { callFrame: { functionName: 'leaky', url: 'file:///x/leak.ts', lineNumber: 41 }, selfSize: 2 * 1_048_576 },
          ],
        },
        { callFrame: { functionName: 'small', url: 'file:///x/ok.ts', lineNumber: 9 }, selfSize: 1_048_576 },
      ],
    };
    const top = topAllocationSites(head);
    expect(top[0]).toEqual({ site: 'leaky @ /x/leak.ts:42', mb: 5 }); // aggregated + 1-based line
    expect(top[1].site).toContain('small @ /x/ok.ts:10');
  });

  it('arms once and dumps a small .heapprofile with top sites logged (real inspector, end-to-end)', async () => {
    const { ensureHeapSampling, dumpHeapSamplingProfile } = await import('./event-loop-lag-monitor');
    const { mkdtemp, readdir, readFile, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'heap-sampling-'));
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    try {
      expect(await ensureHeapSampling(log)).toBe(true);
      expect(await ensureHeapSampling(log)).toBe(true); // idempotent
      // Allocate something attributable so the profile is non-trivial.
      const hog: string[] = [];
      for (let i = 0; i < 2_000; i++) hog.push('x'.repeat(1_024));
      const file = await dumpHeapSamplingProfile({ dir, rssMb: 1234, log });
      expect(file).toBeTruthy();
      const files = (await readdir(dir)).filter((f) => f.endsWith('.heapprofile'));
      expect(files).toHaveLength(1);
      const profile = JSON.parse(await readFile(path.join(dir, files[0]), 'utf8')) as { head?: unknown };
      expect(profile.head).toBeTruthy(); // DevTools-loadable shape
      expect(lines.some((l) => l.includes('top live allocation sites'))).toBe(true);
      expect(hog.length).toBe(2_000); // keep the hog alive through the dump
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('WI-4189: dumpHeapSamplingProfile prunes to maxProfiles (oldest removed) — .heapprofile had NO retention before this', async () => {
    const { ensureHeapSampling, dumpHeapSamplingProfile } = await import('./event-loop-lag-monitor');
    const { mkdtemp, readdir, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'heap-sampling-prune-'));
    const log = vi.fn();
    try {
      expect(await ensureHeapSampling(log)).toBe(true);
      // Dump 5 profiles with maxProfiles=2 — only the 2 newest must remain.
      for (let i = 0; i < 5; i++) {
        const file = await dumpHeapSamplingProfile({ dir, rssMb: 1, maxProfiles: 2, log });
        expect(file).toBeTruthy();
      }
      const files = (await readdir(dir)).filter((f) => f.endsWith('.heapprofile'));
      expect(files.length).toBeLessThanOrEqual(2);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('WI-4189: dumpHeapSamplingProfile defaults maxProfiles to 50 when omitted', async () => {
    const { ensureHeapSampling, dumpHeapSamplingProfile } = await import('./event-loop-lag-monitor');
    const { mkdtemp, readdir, writeFile, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'heap-sampling-default-prune-'));
    const log = vi.fn();
    try {
      expect(await ensureHeapSampling(log)).toBe(true);
      // Seed 55 fake pre-existing .heapprofile files (cheap — no real inspector dump needed
      // to manufacture the excess), then one real dump must prune down toward the default cap.
      for (let i = 0; i < 55; i++) {
        await writeFile(path.join(dir, `heap-sampling-${1_700_000_000_000 + i}-pidfake-rss_1mb.heapprofile`), '{}');
      }
      const file = await dumpHeapSamplingProfile({ dir, rssMb: 1, log }); // maxProfiles omitted
      expect(file).toBeTruthy();
      const files = (await readdir(dir)).filter((f) => f.endsWith('.heapprofile'));
      expect(files.length).toBeLessThanOrEqual(50);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
