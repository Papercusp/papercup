import { describe, expect, it, vi } from 'vitest';
import { waitUntilReady } from './wait-until-ready.js';
import type { LivenessProbe, ReadinessProbe } from './types.js';

/**
 * A deterministic fake clock/sleep pair: `sleep(ms)` resolves IMMEDIATELY (no
 * real delay) but advances the fake clock by `ms` first, so `now()` reflects
 * elapsed simulated time. This lets the polling-loop tests below exercise
 * "timeoutMs: 30 minutes" style budgets and land in microseconds of real test
 * time, while still exactly reproducing the loop's real timing decisions.
 */
function fakeClock(startMs = 1_000_000) {
  let t = startMs;
  const now = () => t;
  const sleep = vi.fn(async (ms: number) => {
    t += ms;
  });
  return { now, sleep, advance: (ms: number) => (t += ms) };
}

function readyAfter(n: number): { probe: ReadinessProbe; calls: () => number } {
  let calls = 0;
  return {
    probe: {
      async checkReady() {
        calls += 1;
        return calls > n;
      },
    },
    calls: () => calls,
  };
}

describe('waitUntilReady — level-triggered, never hangs', () => {
  it('resolves on the very FIRST check when already ready — no initial poll delay (the persistent-process case)', async () => {
    const { now, sleep } = fakeClock();
    const { probe, calls } = readyAfter(0); // ready on call #1
    const outcome = await waitUntilReady(probe, undefined, { timeoutMs: 60_000, now, sleep });
    expect(outcome).toEqual({ ok: true, ready: true, elapsedMs: 0 });
    expect(calls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled(); // never waited — proves the first read is a level check, not "wait then check"
  });

  it('polls at the configured interval until ready, reporting exact elapsed time', async () => {
    const { now, sleep } = fakeClock();
    const { probe, calls } = readyAfter(3); // ready on the 4th check
    const outcome = await waitUntilReady(probe, undefined, {
      timeoutMs: 60_000,
      pollIntervalMs: 500,
      now,
      sleep,
    });
    expect(outcome).toEqual({ ok: true, ready: true, elapsedMs: 1500 }); // 3 sleeps of 500ms before the ready read
    expect(calls()).toBe(4);
  });

  it('times out at exactly the configured deadline when the process never becomes ready — bounded, not infinite', async () => {
    const { now, sleep } = fakeClock();
    const probe: ReadinessProbe = { checkReady: async () => false };
    const outcome = await waitUntilReady(probe, undefined, { timeoutMs: 10_000, pollIntervalMs: 1000, now, sleep });
    expect(outcome).toEqual({ ok: false, ready: false, elapsedMs: 10_000, reason: 'timeout' });
  });

  it('fails fast on process death instead of waiting out the remaining deadline', async () => {
    const { now, sleep } = fakeClock();
    const probe: ReadinessProbe = { checkReady: async () => false };
    const liveness: LivenessProbe = { isAlive: async () => false };
    const outcome = await waitUntilReady(probe, liveness, { timeoutMs: 10_000_000, now, sleep });
    expect(outcome).toEqual({ ok: false, ready: false, elapsedMs: 0, reason: 'process_exited' });
    expect(sleep).not.toHaveBeenCalled(); // exits before ever sleeping — the "10,000,000ms budget" was never touched
  });

  it('re-checks liveness on every poll, not just once at the start', async () => {
    const { now, sleep } = fakeClock();
    let aliveCalls = 0;
    const liveness: LivenessProbe = {
      isAlive: async () => {
        aliveCalls += 1;
        return true; // stays alive throughout; readiness itself is what's slow to arrive
      },
    };
    const { probe, calls } = readyAfter(2); // ready on the 3rd check
    const outcome = await waitUntilReady(probe, liveness, { timeoutMs: 60_000, pollIntervalMs: 100, now, sleep });
    expect(outcome.ok).toBe(true);
    expect(aliveCalls).toBe(calls()); // liveness paired 1:1 with each readiness poll
    expect(aliveCalls).toBeGreaterThan(1);
  });

  it('NEVER hangs on a probe call that never resolves — a single wedged check is bounded by probeTimeoutMs, not the process lifetime', async () => {
    // Real timers here (no fake now/sleep) — this is the direct proof that a
    // never-resolving checkReady() cannot hang the whole wait: the promise it
    // returns is simply never awaited past probeTimeoutMs.
    const probe: ReadinessProbe = { checkReady: () => new Promise<boolean>(() => {}) }; // never settles
    const startedAt = Date.now();
    const outcome = await waitUntilReady(probe, undefined, {
      timeoutMs: 30,
      probeTimeoutMs: 10,
      pollIntervalMs: 5,
    });
    const wallClockMs = Date.now() - startedAt;
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('timeout');
    // Generous real-world bound (well under any plausible "it actually hung" duration) —
    // proves this call returned promptly instead of blocking forever on the wedged probe.
    expect(wallClockMs).toBeLessThan(2000);
  });

  it('rejects a negative timeoutMs rather than silently waiting forever', async () => {
    const probe: ReadinessProbe = { checkReady: async () => true };
    await expect(waitUntilReady(probe, undefined, { timeoutMs: -1 })).rejects.toThrow(/timeoutMs/);
  });
});
