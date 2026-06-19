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
});
