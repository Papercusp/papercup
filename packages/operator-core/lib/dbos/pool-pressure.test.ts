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
  attributableLoopDelayMs,
  poolLatencyNetOfLoopDelayMs,
  lastPoolProbeRawMs,
  lastPoolProbeLoopDelayMs,
} from './pool-pressure';
import type { LoopLagSample } from '../event-loop-lag-monitor';

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

/**
 * WI-10001531 — LOOP-DELAY CONTAMINATION.
 *
 * The probe times `acquire + SELECT 1` as `now() - start` ACROSS AN `await`. On a
 * CPU-bound main thread that wall-clock delta is dominated by event-loop scheduling
 * delay, not pool acquisition — so main-thread saturation was classified as pool
 * starvation and shed twice (once correctly as loop pressure, once wrongly here).
 * Measured proof: the probe reported 8191ms against its own 3000ms `Promise.race`
 * budget — arithmetically impossible from I/O; the timer itself fired 5.2s late.
 *
 * The repair discounts the concurrent loop delay (p99) from the raw reading and
 * classifies the NET value. These cases pin that boundary with no real timers and no
 * real pool. The case that FAILS on pre-fix code is marked ⛔ below — it is the whole
 * point of this block, so if a future refactor makes it pass vacuously the guard is
 * gone.
 */
const lagWith = (p99Ms: number, over: Partial<LoopLagSample> = {}): LoopLagSample => ({
  p50Ms: 22,
  p95Ms: 1568,
  p99Ms,
  maxMs: Math.max(p99Ms, 1),
  sampleCount: 500,
  windowMs: 10_000,
  windowMature: true,
  ...over,
});

describe('attributableLoopDelayMs (pure — the delay a single probe may be charged)', () => {
  it('is p99 — NOT max (one outlier would zero the pool signal for the whole window)', () => {
    expect(attributableLoopDelayMs(lagWith(2336, { maxMs: 9999 }))).toBe(2336);
  });
  it('is 0 with no monitor, so absence of a loop signal leaves the raw probe untouched', () => {
    expect(attributableLoopDelayMs(null)).toBe(0);
  });
  it('is 0 for an unusable p99 (NaN/∞/negative/zero) — never invents a discount', () => {
    expect(attributableLoopDelayMs(lagWith(NaN))).toBe(0);
    expect(attributableLoopDelayMs(lagWith(Infinity))).toBe(0);
    expect(attributableLoopDelayMs(lagWith(-5))).toBe(0);
    expect(attributableLoopDelayMs(lagWith(0))).toBe(0);
  });
});

describe('poolLatencyNetOfLoopDelayMs (pure — raw net of scheduler delay)', () => {
  it('subtracts the attributable delay', () => {
    expect(poolLatencyNetOfLoopDelayMs(2500, lagWith(2336))).toBe(164);
  });
  it('clamps at 0 — a negative "pool latency" is meaningless', () => {
    expect(poolLatencyNetOfLoopDelayMs(100, lagWith(2336))).toBe(0);
  });
  it('passes a non-finite raw through UNCHANGED, preserving the NaN/∞ ⇒ ok rule', () => {
    expect(poolLatencyNetOfLoopDelayMs(NaN, lagWith(2336))).toBeNaN();
    expect(classifyPoolPressure(poolLatencyNetOfLoopDelayMs(NaN, lagWith(2336)))).toBe('ok');
  });
});

describe('probePoolLatencyMs — loop delay is discounted, pool starvation is not', () => {
  const clockOf = (values: number[]) => {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
  };
  const fastProbe = async () => 1;

  it('⛔ FAILS PRE-FIX: a BLOCKED LOOP with a FAST pool classifies ok, not critical', async () => {
    // The live HELD reading: raw 2500ms wall-clock while the pool itself was idle, with
    // the loop monitor reporting p99 2336ms in the same window. Pre-fix this classified
    // on 2500 ⇒ 'critical' ⇒ the dispatch window collapsed to 1 and routinesTick withheld
    // every remaining due routine WITHOUT advancing next_fire_at. Net is 164 ⇒ 'ok'.
    const ms = await probePoolLatencyMs(
      fastProbe,
      clockOf([0, 2500, 2500]),
      3000,
      () => lagWith(2336),
    );
    expect(ms).toBe(164);
    expect(classifyPoolPressure(ms)).toBe('ok');
  });

  it('retains raw + discounted delay so a corrected ok stays ATTRIBUTABLE', async () => {
    // Without these a corrected 'ok' is indistinguishable from a genuinely idle pool.
    await probePoolLatencyMs(fastProbe, clockOf([0, 2500, 2500]), 3000, () => lagWith(2336));
    expect(lastPoolProbeMs()).toBe(164); // what consumers classify on
    expect(lastPoolProbeRawMs()).toBe(2500); // the contaminated reading
    expect(lastPoolProbeLoopDelayMs()).toBe(2336); // why they differ
  });

  it('does NOT relax the guard: a HEALTHY loop with a genuinely slow pool stays critical', async () => {
    const ms = await probePoolLatencyMs(fastProbe, clockOf([0, 2500, 2500]), 3000, () =>
      lagWith(5),
    );
    expect(ms).toBe(2495);
    expect(classifyPoolPressure(ms)).toBe('critical');
  });

  it('no monitor (null) ⇒ byte-identical to pre-fix behaviour', async () => {
    const ms = await probePoolLatencyMs(fastProbe, clockOf([0, 2500, 2500]), 3000, () => null);
    expect(ms).toBe(2500);
    expect(classifyPoolPressure(ms)).toBe('critical');
    expect(lastPoolProbeLoopDelayMs()).toBe(0);
  });

  it('fail-soft: a THROWING loop-lag read degrades to the raw reading, never throws', async () => {
    const ms = await probePoolLatencyMs(fastProbe, clockOf([0, 2500, 2500]), 3000, () => {
      throw new Error('monitor exploded');
    });
    expect(ms).toBe(2500);
    expect(classifyPoolPressure(ms)).toBe('critical');
  });

  it('reads the monitor ONCE — two reads of a live window could disagree', async () => {
    // A second read would leave the recorded delay unable to explain the reported value.
    let reads = 0;
    await probePoolLatencyMs(fastProbe, clockOf([0, 2500, 2500]), 3000, () => {
      reads += 1;
      return lagWith(2336);
    });
    expect(reads).toBe(1);
  });
});

describe('probePoolLatencyMs — TIMEOUT attribution (pool starvation vs scheduler artifact)', () => {
  const clockOf = (values: number[]) => {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
  };
  const neverSettles = () => new Promise(() => {});

  it('a timeout NOT explained by loop delay still FORCES critical (pre-existing contract)', async () => {
    // Deliberately preserved: the pool could not service a trivial query in the budget.
    const ms = await probePoolLatencyMs(neverSettles, clockOf([0, 100, 100]), 20, () => null);
    expect(ms).toBeGreaterThanOrEqual(CRITICAL_PROBE_MS);
    expect(classifyPoolPressure(ms)).toBe('critical');
  });

  it('a timeout the loop delay ACCOUNTS FOR is a scheduler artifact ⇒ not forced', async () => {
    // raw 100ms, of which 95ms is scheduler delay ⇒ the pool itself owed 5ms. The timer
    // fired because the loop was blocked, not because the pool was starved; forcing
    // critical here is the double-shed this repair removes (dimension (a) keeps its own
    // guard, so the loop pressure is still shed — once).
    const ms = await probePoolLatencyMs(neverSettles, clockOf([0, 100, 100]), 20, () =>
      lagWith(95),
    );
    expect(ms).toBe(5);
    expect(classifyPoolPressure(ms)).toBe('ok');
  });
});
