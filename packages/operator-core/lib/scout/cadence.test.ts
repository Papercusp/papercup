/**
 * cadence.test.ts — Scout P-008 cadence gate (D-010 / b6c3f Risk A).
 * Pins the "idle-capacity OR friction-triggered, never blind clock" semantics
 * + the floors, as a pure decision over fabricated state (no real clock).
 */
import { describe, it, expect } from 'vitest';
import { shouldRunScoutCycle, type ScoutCadenceState } from './cadence';

const NOW = Date.parse('2026-06-08T12:00:00Z');
function state(p: Partial<ScoutCadenceState> = {}): ScoutCadenceState {
  return { idleRatio: 0, frictionSignals: 0, lastRunAtMs: null, nowMs: NOW, ...p };
}
const minutesAgo = (m: number) => NOW - m * 60_000;

describe('shouldRunScoutCycle (P-008 cadence)', () => {
  it('fires on idle-capacity when never run and the fleet is idle', () => {
    const v = shouldRunScoutCycle(state({ idleRatio: 0.8, lastRunAtMs: null }));
    expect(v).toEqual({ fire: true, reason: 'idle-capacity' });
  });

  it('fires friction-triggered when friction crosses the threshold (never run)', () => {
    const v = shouldRunScoutCycle(state({ idleRatio: 0, frictionSignals: 5, lastRunAtMs: null }));
    expect(v).toEqual({ fire: true, reason: 'friction-triggered' });
  });

  it('does NOT fire on a blind clock — idle below threshold, no friction, within heartbeat', () => {
    const v = shouldRunScoutCycle(state({ idleRatio: 0.2, frictionSignals: 0, lastRunAtMs: minutesAgo(120) }));
    expect(v.fire).toBe(false);
    expect(v.reason).toBe('no-trigger');
  });

  it('withholds within the min-interval floor (idle path) with a retryAfter', () => {
    const v = shouldRunScoutCycle(state({ idleRatio: 1, lastRunAtMs: minutesAgo(10) })); // 10m < 60m floor
    expect(v.fire).toBe(false);
    expect(v.reason).toBe('min-interval');
    expect(v.retryAfterSec).toBe(50 * 60);
  });

  it('friction bypasses the NORMAL floor (fires inside min-interval, past the short friction floor)', () => {
    // 20m since last run: < 60m normal floor, but ≥ 15m friction floor → friction fires.
    const v = shouldRunScoutCycle(state({ frictionSignals: 9, idleRatio: 0, lastRunAtMs: minutesAgo(20) }));
    expect(v).toEqual({ fire: true, reason: 'friction-triggered' });
  });

  it('friction still respects its own short floor', () => {
    // 5m since last run: < 15m friction floor → withheld.
    const v = shouldRunScoutCycle(state({ frictionSignals: 9, lastRunAtMs: minutesAgo(5) }));
    expect(v.fire).toBe(false);
    expect(v.reason).toBe('min-interval');
    expect(v.retryAfterSec).toBe(10 * 60);
  });

  it('fires heartbeat when the max-interval ceiling elapses with no trigger', () => {
    const v = shouldRunScoutCycle(
      state({ idleRatio: 0.1, frictionSignals: 0, lastRunAtMs: minutesAgo(60 * 25) }), // 25h > 24h ceiling
    );
    expect(v).toEqual({ fire: true, reason: 'heartbeat' });
  });

  it('maxIntervalSec=0 disables the heartbeat', () => {
    const v = shouldRunScoutCycle(
      state({ idleRatio: 0.1, lastRunAtMs: minutesAgo(60 * 100) }),
      { maxIntervalSec: 0 },
    );
    expect(v.fire).toBe(false);
    expect(v.reason).toBe('no-trigger');
  });

  it('respects custom thresholds', () => {
    // lastRunAtMs recent (and < the heartbeat ceiling) so we isolate the trigger
    // thresholds — a never-run state would fire the heartbeat regardless.
    const opts = { idleThreshold: 0.9, frictionThreshold: 1, minIntervalSec: 0 };
    const recent = { lastRunAtMs: minutesAgo(30) };
    expect(shouldRunScoutCycle(state({ idleRatio: 0.8, ...recent }), opts).fire).toBe(false); // 0.8 < 0.9
    expect(shouldRunScoutCycle(state({ idleRatio: 0.95, ...recent }), opts).reason).toBe('idle-capacity');
    expect(shouldRunScoutCycle(state({ frictionSignals: 1, ...recent }), opts).reason).toBe('friction-triggered');
  });

  it('fires heartbeat on the very first tick (never run, no idle/friction)', () => {
    const v = shouldRunScoutCycle(state({ idleRatio: 0, frictionSignals: 0, lastRunAtMs: null }));
    expect(v).toEqual({ fire: true, reason: 'heartbeat' });
  });
});

describe('shouldRunScoutCycle — clock edges (scout-loop-test-plan P-005)', () => {
  it('zero elapsed (tick lands on the same ms as the last run) withholds with the full floor', () => {
    const v = shouldRunScoutCycle(state({ idleRatio: 1, lastRunAtMs: NOW }));
    expect(v).toEqual({ fire: false, reason: 'min-interval', retryAfterSec: 3600 });
  });

  it('a FUTURE lastRunAtMs (clock skew) withholds the idle path and extends retryAfter past the floor', () => {
    // The wall clock stepped back 2 minutes: elapsed is negative — the gate must
    // withhold (never fire on skew) and quote floor + skew, not crash or go negative.
    const v = shouldRunScoutCycle(state({ idleRatio: 1, lastRunAtMs: NOW + 120_000 }));
    expect(v).toEqual({ fire: false, reason: 'min-interval', retryAfterSec: 3600 + 120 });
  });

  it('a future lastRunAtMs withholds the friction path too (friction floor + skew)', () => {
    const v = shouldRunScoutCycle(state({ frictionSignals: 9, lastRunAtMs: NOW + 60_000 }));
    expect(v).toEqual({ fire: false, reason: 'min-interval', retryAfterSec: 900 + 60 });
  });

  it('fractional-second elapsed rounds retryAfterSec UP to a whole second (never 0)', () => {
    // 3599.4s elapsed → 0.6s short of the floor → ceil → 1.
    const v = shouldRunScoutCycle(state({ idleRatio: 1, lastRunAtMs: NOW - 3_599_400 }));
    expect(v).toEqual({ fire: false, reason: 'min-interval', retryAfterSec: 1 });
  });

  it('minIntervalSec: 0 disables the floor — idle fires on the same tick as the last run', () => {
    const v = shouldRunScoutCycle(state({ idleRatio: 1, lastRunAtMs: NOW }), { minIntervalSec: 0 });
    expect(v).toEqual({ fire: true, reason: 'idle-capacity' });
  });

  it('negative / NaN interval options fall back to the defaults (no negative floor)', () => {
    const v = shouldRunScoutCycle(
      state({ idleRatio: 1, lastRunAtMs: minutesAgo(30) }),
      { minIntervalSec: -50, maxIntervalSec: Number.NaN },
    );
    expect(v).toEqual({ fire: false, reason: 'min-interval', retryAfterSec: 30 * 60 });
  });

  it('a NaN idleRatio never idle-fires (fails safe to no-trigger inside the ceiling)', () => {
    const v = shouldRunScoutCycle(state({ idleRatio: Number.NaN, lastRunAtMs: minutesAgo(120) }));
    expect(v).toEqual({ fire: false, reason: 'no-trigger' });
  });

  it('the friction floor tracks a SHORTER minIntervalSec (default = min(minInterval, 900))', () => {
    const opts = { minIntervalSec: 600 };
    expect(shouldRunScoutCycle(state({ frictionSignals: 3, lastRunAtMs: NOW - 600_000 }), opts))
      .toEqual({ fire: true, reason: 'friction-triggered' }); // 600s ≥ min(600, 900)
    expect(shouldRunScoutCycle(state({ frictionSignals: 3, lastRunAtMs: NOW - 599_000 }), opts))
      .toEqual({ fire: false, reason: 'min-interval', retryAfterSec: 1 });
  });

  it('an explicit minFrictionIntervalSec LONGER than the normal floor is honored', () => {
    const opts = { minFrictionIntervalSec: 7200 };
    expect(shouldRunScoutCycle(state({ frictionSignals: 9, lastRunAtMs: minutesAgo(90) }), opts))
      .toEqual({ fire: false, reason: 'min-interval', retryAfterSec: 30 * 60 }); // 90m < 120m friction floor
    expect(shouldRunScoutCycle(state({ frictionSignals: 9, lastRunAtMs: minutesAgo(120) }), opts))
      .toEqual({ fire: true, reason: 'friction-triggered' });
  });
});
