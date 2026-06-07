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
import { startEventLoopLagMonitor, type LagMonitorHandle } from './event-loop-lag-monitor';

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
