import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shouldSelfRestart, startLagSelfRestart } from './lag-self-restart';

describe('shouldSelfRestart (pure)', () => {
  it('false below the sustain window', () => {
    expect(shouldSelfRestart({ consecutiveCritical: 3, sustainChecks: 8, uptimeMs: 999_999, minUptimeMs: 0 })).toBe(false);
  });
  it('true once sustained AND past minimum uptime', () => {
    expect(shouldSelfRestart({ consecutiveCritical: 8, sustainChecks: 8, uptimeMs: 200_000, minUptimeMs: 120_000 })).toBe(true);
  });
  it('false while still inside the minimum-uptime guard (slow boot never recycles)', () => {
    expect(shouldSelfRestart({ consecutiveCritical: 50, sustainChecks: 8, uptimeMs: 30_000, minUptimeMs: 120_000 })).toBe(false);
  });
});

describe('startLagSelfRestart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('is an inert no-op when not armed (default OFF)', () => {
    // Hermeticity: the bg-host / green-checkpoint runner can have
    // PAPERCUSP_LAG_SELF_RESTART=1 set live (armed as a stall mitigation).
    // vi.unstubAllEnvs() only clears vi.stubEnv() stubs, NOT the ambient process
    // env — so force the flag OFF here to test the true default-OFF behavior
    // regardless of the runner's environment (otherwise this red-pins the gate).
    vi.stubEnv('PAPERCUSP_LAG_SELF_RESTART', '');
    const exit = vi.fn();
    const h = startLagSelfRestart({ intervalMs: 1000, sustainChecks: 2, minUptimeMs: 0, pressure: () => 'critical', exit, now: () => 1_000_000, bootAt: 0, log: vi.fn() });
    vi.advanceTimersByTime(10_000);
    expect(exit).not.toHaveBeenCalled();
    expect(h.consecutiveCritical()).toBe(0);
    h.stop();
  });

  it('armed: recycles (exit 75) after the loop is critical for the full sustain window', () => {
    vi.stubEnv('PAPERCUSP_LAG_SELF_RESTART', '1');
    const exit = vi.fn();
    const h = startLagSelfRestart({ intervalMs: 1000, sustainChecks: 3, minUptimeMs: 0, pressure: () => 'critical', exit, now: () => 1_000_000, bootAt: 0, log: vi.fn() });
    vi.advanceTimersByTime(1000); // c=1
    vi.advanceTimersByTime(1000); // c=2
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); // c=3 → trigger → schedule 250ms exit
    vi.advanceTimersByTime(250);
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
    h.stop();
  });

  it('armed: a single non-critical sample resets the streak (a transient spike never recycles)', () => {
    vi.stubEnv('PAPERCUSP_LAG_SELF_RESTART', '1');
    const exit = vi.fn();
    const seq = ['critical', 'critical', 'ok', 'critical', 'critical'] as const;
    let i = 0;
    const h = startLagSelfRestart({ intervalMs: 1000, sustainChecks: 3, minUptimeMs: 0, pressure: () => seq[Math.min(i++, seq.length - 1)], exit, now: () => 1_000_000, bootAt: 0, log: vi.fn() });
    vi.advanceTimersByTime(5000); // 5 samples: c→1,2,reset0,1,2 — never 3 consecutive
    expect(exit).not.toHaveBeenCalled();
    h.stop();
  });

  it('armed: does NOT recycle while inside the minimum-uptime guard', () => {
    vi.stubEnv('PAPERCUSP_LAG_SELF_RESTART', '1');
    const exit = vi.fn();
    // now - bootAt = 10_000 < minUptimeMs 120_000 → uptime guard blocks the recycle
    const h = startLagSelfRestart({ intervalMs: 1000, sustainChecks: 2, minUptimeMs: 120_000, pressure: () => 'critical', exit, now: () => 10_000, bootAt: 0, log: vi.fn() });
    vi.advanceTimersByTime(10_000);
    expect(exit).not.toHaveBeenCalled();
    h.stop();
  });

  // P-003 (mcp-reliability-hardening-2026-07-11): jitter desynchronizes co-saturated
  // reusePort siblings so they don't all recycle in the same beat (7 recycles in ~4min
  // observed 2026-07-10). The extra sustain checks are drawn once at start from
  // [0, jitterChecks] via the injected rand seam.
  it('armed: jitterChecks EXTENDS the effective sustain window by the per-process draw', () => {
    vi.stubEnv('PAPERCUSP_LAG_SELF_RESTART', '1');
    const exit = vi.fn();
    // base sustainChecks=3, jitterChecks=4, rand()=1.0 → floor(1.0*5)... but rand is
    // exclusive of 1 in practice; use 0.99 → floor(0.99*5)=4 extra → effective window 7.
    const h = startLagSelfRestart({
      intervalMs: 1000, sustainChecks: 3, jitterChecks: 4, rand: () => 0.99,
      minUptimeMs: 0, pressure: () => 'critical', exit, now: () => 1_000_000, bootAt: 0, log: vi.fn(),
    });
    vi.advanceTimersByTime(6000); // 6 critical samples < effective 7 → no recycle yet
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); // 7th → trigger
    vi.advanceTimersByTime(250);
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
    h.stop();
  });

  it('armed: jitterChecks=0 (default) leaves the base sustain window unchanged', () => {
    vi.stubEnv('PAPERCUSP_LAG_SELF_RESTART', '1');
    const exit = vi.fn();
    // rand must NOT be consulted when jitterChecks is 0 — window stays exactly 2.
    const rand = vi.fn(() => 0.99);
    const h = startLagSelfRestart({
      intervalMs: 1000, sustainChecks: 2, jitterChecks: 0, rand,
      minUptimeMs: 0, pressure: () => 'critical', exit, now: () => 1_000_000, bootAt: 0, log: vi.fn(),
    });
    vi.advanceTimersByTime(2000); // exactly 2 → trigger
    vi.advanceTimersByTime(250);
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
    expect(rand).not.toHaveBeenCalled();
    h.stop();
  });
});
