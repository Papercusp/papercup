import { describe, expect, it, vi } from 'vitest';
import { measureGuiColdStart } from './cold-start.js';
import type { LivenessProbe, ReadinessProbe } from './types.js';

function fakeClock(startMs = 1_000_000) {
  let t = startMs;
  const now = () => t;
  const sleep = vi.fn(async (ms: number) => {
    t += ms;
  });
  return { now, sleep };
}

function readyAfter(n: number): ReadinessProbe {
  let calls = 0;
  return {
    async checkReady() {
      calls += 1;
      return calls > n;
    },
  };
}

describe('measureGuiColdStart', () => {
  it("origin:'launched' — reports birth-to-ready latency when the process becomes ready immediately", async () => {
    const { now, sleep } = fakeClock(1_000_000);
    const probe = readyAfter(0);
    const result = await measureGuiColdStart(probe, undefined, {
      origin: 'launched',
      launchedAtMs: 1_000_000,
      timeoutMs: 30_000,
      now,
      sleep,
    });
    expect(result).toEqual({ ok: true, ready: true, origin: 'launched', waitedMs: 0, coldStartMs: 0 });
  });

  it("origin:'launched' — includes setup time BEFORE this call started watching (launchedAtMs earlier than call entry)", async () => {
    const { now, sleep } = fakeClock(1_000_500); // call starts 500ms after the process actually launched
    const probe = readyAfter(0); // already ready by the time we start watching
    const result = await measureGuiColdStart(probe, undefined, {
      origin: 'launched',
      launchedAtMs: 1_000_000,
      timeoutMs: 30_000,
      now,
      sleep,
    });
    expect(result.ok).toBe(true);
    expect(result.waitedMs).toBe(0); // this call itself didn't have to wait...
    expect(result.coldStartMs).toBe(500); // ...but the true cold-start latency is still correctly attributed
  });

  it("origin:'launched' — cold-start accrues through however many polls it actually took", async () => {
    const { now, sleep } = fakeClock(2_000_000);
    const probe = readyAfter(4);
    const result = await measureGuiColdStart(probe, undefined, {
      origin: 'launched',
      timeoutMs: 60_000,
      pollIntervalMs: 250,
      now,
      sleep,
    });
    expect(result.ok).toBe(true);
    expect(result.waitedMs).toBe(1000);
    expect(result.coldStartMs).toBe(1000); // launchedAtMs defaulted to call-entry, so cold-start === waited here
  });

  it("origin:'attached' — NEVER reports a cold-start number, even when ready instantly (the persistent-process case)", async () => {
    const { now, sleep } = fakeClock();
    const probe = readyAfter(0);
    const result = await measureGuiColdStart(probe, undefined, {
      origin: 'attached',
      timeoutMs: 30_000,
      now,
      sleep,
    });
    expect(result.ok).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.waitedMs).toBe(0);
    expect(result.coldStartMs).toBeNull(); // no birth was observed — nothing to attribute a cold-start latency to
  });

  it("origin:'attached' — still resolves promptly (never hangs) instead of waiting for a launch signal that will never fire", async () => {
    const { now, sleep } = fakeClock();
    const probe = readyAfter(0);
    const result = await measureGuiColdStart(probe, undefined, {
      origin: 'attached',
      timeoutMs: 3_600_000, // a huge budget — proves we don't burn it waiting on nothing
      now,
      sleep,
    });
    expect(result.waitedMs).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a timed-out wait never reports a coldStartMs, regardless of origin', async () => {
    const { now, sleep } = fakeClock();
    const probe: ReadinessProbe = { checkReady: async () => false };
    const result = await measureGuiColdStart(probe, undefined, {
      origin: 'launched',
      timeoutMs: 5000,
      pollIntervalMs: 1000,
      now,
      sleep,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeout');
    expect(result.coldStartMs).toBeNull();
  });

  it('a process that exits before becoming ready reports process_exited with no coldStartMs', async () => {
    const { now, sleep } = fakeClock();
    const probe: ReadinessProbe = { checkReady: async () => false };
    const liveness: LivenessProbe = { isAlive: async () => false };
    const result = await measureGuiColdStart(probe, liveness, {
      origin: 'launched',
      timeoutMs: 60_000,
      now,
      sleep,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('process_exited');
    expect(result.coldStartMs).toBeNull();
  });
});
