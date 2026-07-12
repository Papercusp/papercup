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
    // Explicit 24h ceiling so 2h elapsed is WITHIN it (the DEFAULT heartbeat is now
    // 1h, owner-set — under the default this case would heartbeat-fire, which is the
    // intended hourly behavior; here we isolate the no-trigger path with a long ceiling).
    const v = shouldRunScoutCycle(state({ idleRatio: 0.2, frictionSignals: 0, lastRunAtMs: minutesAgo(120) }), { maxIntervalSec: 86400 });
    expect(v.fire).toBe(false);
    expect(v.reason).toBe('no-trigger');
  });

  it('the DEFAULT heartbeat is hourly — fires once ~1h elapses even on a busy/non-idle hive (owner-set 2026-06-18)', () => {
    // idle below threshold + no friction + past the 1h default ceiling → heartbeat.
    const v = shouldRunScoutCycle(state({ idleRatio: 0.1, frictionSignals: 0, lastRunAtMs: minutesAgo(61) }));
    expect(v).toEqual({ fire: true, reason: 'heartbeat' });
    // …and still WITHIN the 1h floor it withholds (so it's ~hourly, not every tick).
    const w = shouldRunScoutCycle(state({ idleRatio: 0.1, frictionSignals: 0, lastRunAtMs: minutesAgo(40) }));
    expect(w.fire).toBe(false);
    expect(w.reason).toBe('min-interval');
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
      state({ idleRatio: 0.1, frictionSignals: 0, lastRunAtMs: minutesAgo(90) }), // 90m > 60m (1h) default ceiling
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

describe('shouldRunScoutCycle — ideas-drained trigger (owner-set 2026-06-18)', () => {
  // Past the 1h floor, idle below threshold, no friction — so the drain trigger
  // (when armed) is what decides, isolated from idle/friction/heartbeat.
  const drained = (over: Partial<ScoutCadenceState> = {}) =>
    state({ idleRatio: 0.1, frictionSignals: 0, lastRunAtMs: minutesAgo(90), ...over });

  it('fires when every prior idea is resolved (total > 0, pending 0)', () => {
    const v = shouldRunScoutCycle(drained({ routedIdeaTotal: 8, pendingIdeaCount: 0 }), { maxIntervalSec: 86400 });
    expect(v).toEqual({ fire: true, reason: 'ideas-drained' });
  });

  it('does NOT fire while any idea is still pending (falls through to no-trigger under a long ceiling)', () => {
    const v = shouldRunScoutCycle(drained({ routedIdeaTotal: 8, pendingIdeaCount: 3 }), { maxIntervalSec: 86400 });
    expect(v).toEqual({ fire: false, reason: 'no-trigger' });
  });

  it('does NOT fire for a never-routed scout (total 0 — no spurious drain fire; heartbeat covers first runs)', () => {
    const v = shouldRunScoutCycle(drained({ routedIdeaTotal: 0, pendingIdeaCount: 0 }), { maxIntervalSec: 86400 });
    expect(v).toEqual({ fire: false, reason: 'no-trigger' });
  });

  it('is DISABLED when the scheduler omits the counts (pure-gate default, back-compat)', () => {
    const v = shouldRunScoutCycle(drained(), { maxIntervalSec: 86400 }); // no routedIdeaTotal/pendingIdeaCount
    expect(v).toEqual({ fire: false, reason: 'no-trigger' });
  });

  it('respects the min-interval floor — a drained queue still waits out the hour', () => {
    const v = shouldRunScoutCycle(
      drained({ lastRunAtMs: minutesAgo(20), routedIdeaTotal: 8, pendingIdeaCount: 0 }),
    );
    expect(v.fire).toBe(false);
    expect(v.reason).toBe('min-interval');
  });

  it('outranks idle-capacity for the reason when both apply (drain is the more specific signal)', () => {
    const v = shouldRunScoutCycle(
      drained({ idleRatio: 0.9, routedIdeaTotal: 8, pendingIdeaCount: 0 }),
      { maxIntervalSec: 86400 },
    );
    expect(v).toEqual({ fire: true, reason: 'ideas-drained' });
  });

  it('friction still outranks a drained queue (a stuck colony leaps first)', () => {
    const v = shouldRunScoutCycle(
      drained({ frictionSignals: 9, routedIdeaTotal: 8, pendingIdeaCount: 0 }),
    );
    expect(v).toEqual({ fire: true, reason: 'friction-triggered' });
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
    // Explicit long ceiling so 2h is within it (the default heartbeat is now 1h).
    const v = shouldRunScoutCycle(state({ idleRatio: Number.NaN, lastRunAtMs: minutesAgo(120) }), { maxIntervalSec: 86400 });
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

describe('queen-feedback bypass (P-002 — queen-scout-feedback-loop)', () => {
  it('fires queen-feedback out-of-cadence, PAST the min-interval floor', () => {
    // Just-ran (1m ago) → the normal floor would withhold; queen feedback overrides.
    const v = shouldRunScoutCycle(state({ queenWakePending: true, lastRunAtMs: minutesAgo(1), idleRatio: 0 }));
    expect(v).toEqual({ fire: true, reason: 'queen-feedback' });
  });

  it('PREEMPTS friction (D-003 #4 — revision before fresh ideation)', () => {
    const v = shouldRunScoutCycle(
      state({ queenWakePending: true, frictionSignals: 9, idleRatio: 1, lastRunAtMs: minutesAgo(0.1) }),
    );
    expect(v).toEqual({ fire: true, reason: 'queen-feedback' });
  });

  it('fires even when never run', () => {
    const v = shouldRunScoutCycle(state({ queenWakePending: true, lastRunAtMs: null }));
    expect(v).toEqual({ fire: true, reason: 'queen-feedback' });
  });

  it('is inert (pure-gate default) when queenWakePending is absent/false — cadence unchanged', () => {
    // Same withholding state as the min-interval test, but without the flag.
    expect(shouldRunScoutCycle(state({ idleRatio: 1, lastRunAtMs: minutesAgo(10) })).reason).toBe('min-interval');
    expect(
      shouldRunScoutCycle(state({ queenWakePending: false, idleRatio: 1, lastRunAtMs: minutesAgo(10) })).reason,
    ).toBe('min-interval');
  });
});

describe('VOLUME MODE — signalScore supplied (blender-self-learning-2026-07-12 P-002 / WI-4318)', () => {
  // In every case below the accumulator score is a finite number, which is the
  // scheduler's "flag ON + accumulator populated" shape.

  it('score 0 withholds EVERYTHING except queen-feedback (a stale corpus never fires)', () => {
    // Idle + past every floor + drained + past heartbeat — all vetoed at score 0.
    const v = shouldRunScoutCycle(
      state({
        signalScore: 0,
        idleRatio: 1,
        frictionSignals: 99,
        lastRunAtMs: minutesAgo(600),
        routedIdeaTotal: 5,
        pendingIdeaCount: 0,
      }),
    );
    expect(v).toEqual({ fire: false, reason: 'no-signal' });
  });

  it('queen-feedback BYPASSES the zero-signal veto (explicit external signal)', () => {
    const v = shouldRunScoutCycle(
      state({ signalScore: 0, queenWakePending: true, lastRunAtMs: minutesAgo(1) }),
    );
    expect(v).toEqual({ fire: true, reason: 'queen-feedback' });
  });

  it('score ≥ threshold fires signal-volume once the volume floor elapses', () => {
    const v = shouldRunScoutCycle(state({ signalScore: 25, lastRunAtMs: minutesAgo(16) }));
    expect(v).toEqual({ fire: true, reason: 'signal-volume' });
  });

  it('the volume floor (default 15min) coalesces bursts — withheld inside it, retryAfter points at it', () => {
    const v = shouldRunScoutCycle(state({ signalScore: 100, lastRunAtMs: minutesAgo(10) }));
    expect(v.fire).toBe(false);
    expect(v.reason).toBe('min-interval');
    expect(v.retryAfterSec).toBe(5 * 60);
  });

  it('sub-threshold score does NOT volume-fire; heartbeat still bounds the wait (score > 0)', () => {
    // 0 < score < threshold, past the volume floor but inside the heartbeat → no-trigger.
    const early = shouldRunScoutCycle(
      state({ signalScore: 5, idleRatio: 0.2, lastRunAtMs: minutesAgo(30) }),
      { maxIntervalSec: 3600 },
    );
    expect(early.fire).toBe(false);
    expect(early.reason).toBe('no-trigger');
    // …and past the heartbeat ceiling it fires (some signal exists — never fully stalls).
    const late = shouldRunScoutCycle(
      state({ signalScore: 5, idleRatio: 0.2, lastRunAtMs: minutesAgo(61) }),
      { maxIntervalSec: 3600 },
    );
    expect(late).toEqual({ fire: true, reason: 'heartbeat' });
  });

  it('friction keeps its own fast floor in volume mode (score > 0)', () => {
    const v = shouldRunScoutCycle(
      state({ signalScore: 5, frictionSignals: 5, lastRunAtMs: minutesAgo(16) }),
    );
    expect(v).toEqual({ fire: true, reason: 'friction-triggered' });
  });

  it('ideas-drained still fires in volume mode (score > 0, past the volume floor)', () => {
    const v = shouldRunScoutCycle(
      state({ signalScore: 5, routedIdeaTotal: 5, pendingIdeaCount: 0, lastRunAtMs: minutesAgo(16) }),
    );
    expect(v).toEqual({ fire: true, reason: 'ideas-drained' });
  });

  it('threshold + volume floor are tunable via the cadence payload', () => {
    const opts = { signalScoreThreshold: 50, minVolumeIntervalSec: 300 };
    expect(
      shouldRunScoutCycle(state({ signalScore: 49, idleRatio: 0, lastRunAtMs: minutesAgo(6) }), {
        ...opts,
        maxIntervalSec: 86400,
      }).reason,
    ).toBe('no-trigger');
    expect(
      shouldRunScoutCycle(state({ signalScore: 50, lastRunAtMs: minutesAgo(6) }), opts),
    ).toEqual({ fire: true, reason: 'signal-volume' });
    expect(
      shouldRunScoutCycle(state({ signalScore: 50, lastRunAtMs: minutesAgo(4) }), opts).reason,
    ).toBe('min-interval');
  });

  it('LEGACY UNCHANGED: an undefined signalScore keeps the time-based behavior byte-identical', () => {
    // Same states as the legacy tests above — signalScore absent.
    expect(shouldRunScoutCycle(state({ idleRatio: 0.8, lastRunAtMs: null }))).toEqual({
      fire: true,
      reason: 'idle-capacity',
    });
    expect(
      shouldRunScoutCycle(state({ idleRatio: 0.1, frictionSignals: 0, lastRunAtMs: minutesAgo(61) })),
    ).toEqual({ fire: true, reason: 'heartbeat' });
    // A 16-min elapsed idle hive is inside the LEGACY 1h floor (not the 15-min volume floor).
    expect(shouldRunScoutCycle(state({ idleRatio: 1, lastRunAtMs: minutesAgo(16) })).reason).toBe(
      'min-interval',
    );
  });

  it('a NaN score is treated as no-volume-mode (legacy), not as zero (never wedge the loop dark)', () => {
    const v = shouldRunScoutCycle(state({ signalScore: Number.NaN, idleRatio: 0.8, lastRunAtMs: minutesAgo(61) }));
    expect(v).toEqual({ fire: true, reason: 'idle-capacity' });
  });
});
