/**
 * pool-pressure.test.ts — pins the PG-connection-pool-starvation gate for
 * routinesTickImpl (backend-reliability-100pct-2026-07-03 P-006/W4, D-002 + D-003).
 *
 * What this guards:
 *  - classifyPoolPressure: the PURE band split from an acquire+`SELECT 1` latency (ms),
 *    mirroring event-loop-lag-monitor's classifyLoopPressure — including custom bands and
 *    the NaN/∞ ⇒ 'ok' rule (no clean signal must never shed).
 *  - probePoolLatencyMs / poolPressure: the live probe is FAIL-SOFT and classifies by the
 *    RIGHT band for each outcome —
 *      fast resolve            ⇒ 'ok'        (healthy pool)
 *      slow resolve (elevated) ⇒ 'elevated'  (contended)
 *      slow resolve (critical) ⇒ 'critical'  (starved)
 *      TIMEOUT (never settles)  ⇒ 'critical'  (forced, even with a sub-critical test budget)
 *      FAST reject (query error)⇒ 'ok'        (a non-starvation failure must NOT shed)
 *    and publishes lastPoolProbeMs()/At().
 *  - recordPoolShed / poolShedCount: the same-process shed counter increments.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyPoolPressure,
  probePoolLatencyMs,
  poolPressure,
  lastPoolProbeMs,
  lastPoolProbeAt,
  poolShedCount,
  recordPoolShed,
  recordPoolShedEvent,
  hasPoolShedInWindow,
  __resetPoolPressureForTest,
  CRITICAL_PROBE_MS,
} from './pool-pressure';

afterEach(() => __resetPoolPressureForTest());

describe('classifyPoolPressure (pure band split, default 250/2000ms)', () => {
  it('bands by probe latency', () => {
    expect(classifyPoolPressure(0)).toBe('ok');
    expect(classifyPoolPressure(50)).toBe('ok');
    expect(classifyPoolPressure(250)).toBe('elevated');
    expect(classifyPoolPressure(1999)).toBe('elevated');
    expect(classifyPoolPressure(2000)).toBe('critical');
    expect(classifyPoolPressure(9000)).toBe('critical');
  });
  it('honors custom thresholds and is NaN/∞-safe (no signal ⇒ never shed)', () => {
    expect(classifyPoolPressure(50, 40, 100)).toBe('elevated');
    expect(classifyPoolPressure(200, 40, 100)).toBe('critical');
    expect(classifyPoolPressure(NaN)).toBe('ok');
    expect(classifyPoolPressure(Infinity)).toBe('ok');
  });
});

describe('poolPressure — live probe, fail-soft, correct band per outcome', () => {
  // A controllable clock so latency is deterministic regardless of real time. Each call
  // to now() returns the next scripted value.
  const clockOf = (values: number[]) => {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
  };

  it('a fast resolve ⇒ ok, and publishes the last-probe read', async () => {
    // start=1000, end=1005 ⇒ 5ms
    const band = await poolPressure(async () => 1, clockOf([1000, 1005, 1005]));
    expect(band).toBe('ok');
    expect(lastPoolProbeMs()).toBe(5);
    expect(lastPoolProbeAt()).toBe(1005);
  });

  it('a slow resolve in the elevated band ⇒ elevated', async () => {
    // 300ms elapsed ⇒ elevated (≥250, <2000)
    const band = await poolPressure(async () => 1, clockOf([0, 300, 300]));
    expect(band).toBe('elevated');
    expect(lastPoolProbeMs()).toBe(300);
  });

  it('a slow resolve past the critical band ⇒ critical', async () => {
    const band = await poolPressure(async () => 1, clockOf([0, 2500, 2500]));
    expect(band).toBe('critical');
  });

  it('a TIMEOUT (probe never settles) ⇒ critical even with a tiny test budget', async () => {
    // runProbe never resolves; timeoutMs=20 fires; measured elapsed is small but the
    // timeout path forces ≥ CRITICAL_PROBE_MS so it classifies critical.
    const band = await poolPressure(() => new Promise(() => {}), Date.now, 20);
    expect(band).toBe('critical');
    expect(lastPoolProbeMs()).toBeGreaterThanOrEqual(CRITICAL_PROBE_MS);
  });

  it('a FAST reject (a non-starvation query error) ⇒ ok — must NOT shed', async () => {
    const band = await poolPressure(async () => {
      throw new Error('relation does not exist');
    }, clockOf([0, 3, 3]));
    expect(band).toBe('ok');
    expect(lastPoolProbeMs()).toBe(3);
  });

  it('probePoolLatencyMs returns the measured latency and never throws', async () => {
    const ms = await probePoolLatencyMs(async () => 1, clockOf([100, 142, 142]));
    expect(ms).toBe(42);
  });
});

describe('pool-shed counter (same-process attribution)', () => {
  it('recordPoolShed increments and poolShedCount reads it', () => {
    expect(poolShedCount()).toBe(0);
    expect(recordPoolShed()).toBe(1);
    expect(recordPoolShed()).toBe(2);
    expect(poolShedCount()).toBe(2);
  });
});

describe('recordPoolShedEvent (EI-13108 ask 2: durable shed-visibility log)', () => {
  it('fire-and-forget: calls the injected insert with the right args and resolves without awaiting it', async () => {
    const calls: Array<[string, number, number, string]> = [];
    const insert = async (workspaceId: string, shedCount: number, probeMs: number, host: string) => {
      calls.push([workspaceId, shedCount, probeMs, host]);
    };
    recordPoolShedEvent('ws-1', 3, 2500, insert, async () => 'test-host');
    // Synchronous call returns immediately (fire-and-forget) — the insert lands on a
    // later microtask; flush it before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([['ws-1', 3, 2500, 'test-host']]);
  });

  it('never throws even when the injected insert rejects (best-effort telemetry)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      recordPoolShedEvent(
        'ws-1',
        1,
        2500,
        async () => {
          throw new Error('insert failed');
        },
        async () => 'test-host',
      ),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('defaults probeMs to the current lastPoolProbeMs() when the arg is omitted', async () => {
    const values = [0, 777, 777];
    let i = 0;
    await probePoolLatencyMs(async () => 1, () => values[Math.min(i++, values.length - 1)]);
    expect(lastPoolProbeMs()).toBe(777);
    const calls: number[] = [];
    // probeMs omitted entirely ⇒ the `= lastPoolProbeMs()` default parameter applies.
    recordPoolShedEvent(
      'ws-1',
      1,
      undefined,
      async (_w, _s, probeMs) => {
        calls.push(probeMs);
      },
      async () => 'h',
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([777]);
  });
});

describe('hasPoolShedInWindow (EI-13108 ask 2: staleness-consumer query helper)', () => {
  it('returns true when the injected query finds a shed in the window', async () => {
    const result = await hasPoolShedInWindow('ws-1', 60_000, async (workspaceId, windowMs) => {
      expect(workspaceId).toBe('ws-1');
      expect(windowMs).toBe(60_000);
      return true;
    });
    expect(result).toBe(true);
  });

  it('returns false when the injected query finds nothing', async () => {
    const result = await hasPoolShedInWindow('ws-1', 60_000, async () => false);
    expect(result).toBe(false);
  });

  it('fail-soft: a query error returns false, never throws (no shed-signal ≠ claiming a shed)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await hasPoolShedInWindow('ws-1', 60_000, async () => {
      throw new Error('db unavailable');
    });
    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});
