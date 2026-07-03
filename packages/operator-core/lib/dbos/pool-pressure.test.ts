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
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyPoolPressure,
  probePoolLatencyMs,
  poolPressure,
  lastPoolProbeMs,
  lastPoolProbeAt,
  poolShedCount,
  recordPoolShed,
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
