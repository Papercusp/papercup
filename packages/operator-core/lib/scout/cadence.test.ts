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
