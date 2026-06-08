/**
 * cadence.ts — Scout P-008: the autonomous cadence GATE (hive-creative-ideation
 * D-010, "prompt-free, brain-in-loop"; resolves b6c3f's invariants-contract Risk
 * A — `routines.trigger_kind` is only cron|webhook|api, so a bare cron is NOT the
 * plan's cadence).
 *
 * The plan's cadence is "idle-capacity + friction-triggered": the Scout loop
 * should fire when the Hive has spare capacity to explore, OR when accumulated
 * friction signals the colony is stuck and a creative leap is wanted — never on a
 * blind clock. This module is that decision as a PURE gate: a cron routine ticks
 * it, but the {@link runScoutTick} action only actually runs a cycle when this
 * gate says so. Pure ⇒ P-014 can assert fire/no-fire over fabricated state with
 * no real clock or fleet (the verifiability Risk A demanded).
 *
 * Priority (so "friction-triggered" stays responsive without thrash):
 *   1. a short friction floor → friction fires fast when the colony is stuck;
 *   2. the normal min-interval floor guards idle/heartbeat fires;
 *   3. idle-capacity fires when the fleet has spare room;
 *   4. a heartbeat ceiling fires eventually so the loop never fully stalls.
 */

export type ScoutCadenceReason =
  /** Accumulated friction crossed the threshold — the colony is stuck, leap now. */
  | 'friction-triggered'
  /** The fleet has spare capacity to explore. */
  | 'idle-capacity'
  /** Nothing triggered, but the max-interval ceiling elapsed — don't stall. */
  | 'heartbeat'
  /** Withheld: the min-interval floor since the last cycle hasn't elapsed. */
  | 'min-interval'
  /** Withheld: no trigger met and the heartbeat ceiling hasn't elapsed. */
  | 'no-trigger';

/** The live signals the gate reads (supplied by the scheduler from fleet + watchdog). */
export interface ScoutCadenceState {
  /** Fleet idle ratio in [0,1]: 1 = fully idle, 0 = saturated. */
  idleRatio: number;
  /** Count of recent unaddressed friction signals (watchdog + friction-markers). */
  frictionSignals: number;
  /** When the last Scout cycle ran (epoch ms), or null if never. */
  lastRunAtMs: number | null;
  /** Now (epoch ms). */
  nowMs: number;
}

export interface ScoutCadenceOptions {
  /** Floor between cycles for idle/heartbeat fires. Default 3600s (1h). */
  minIntervalSec?: number;
  /** Shorter floor for friction-triggered fires (so friction is responsive). Default min(minInterval, 900s). */
  minFrictionIntervalSec?: number;
  /** Heartbeat ceiling — fire at least this often regardless of triggers. Default 86400s (24h); 0 disables. */
  maxIntervalSec?: number;
  /** idleRatio at/above which idle-capacity fires. Default 0.5. */
  idleThreshold?: number;
  /** frictionSignals at/above which friction fires (within the friction floor). Default 3. */
  frictionThreshold?: number;
}

export interface ScoutCadenceVerdict {
  fire: boolean;
  reason: ScoutCadenceReason;
  /** Seconds until the next possible fire, when withheld by a floor. */
  retryAfterSec?: number;
}

const DEFAULTS = {
  minIntervalSec: 3600,
  maxIntervalSec: 86400,
  idleThreshold: 0.5,
  frictionThreshold: 3,
} as const;

/**
 * Decide whether to run a Scout cycle now. Pure over {@link ScoutCadenceState}.
 */
export function shouldRunScoutCycle(
  state: ScoutCadenceState,
  opts: ScoutCadenceOptions = {},
): ScoutCadenceVerdict {
  const minInterval = nonNeg(opts.minIntervalSec, DEFAULTS.minIntervalSec);
  const minFrictionInterval = nonNeg(opts.minFrictionIntervalSec, Math.min(minInterval, 900));
  const maxInterval = nonNeg(opts.maxIntervalSec, DEFAULTS.maxIntervalSec);
  const idleThreshold = opts.idleThreshold ?? DEFAULTS.idleThreshold;
  const frictionThreshold = opts.frictionThreshold ?? DEFAULTS.frictionThreshold;

  const elapsedSec =
    state.lastRunAtMs == null ? Number.POSITIVE_INFINITY : (state.nowMs - state.lastRunAtMs) / 1000;
  const frictionTriggered = state.frictionSignals >= frictionThreshold;

  // 1. Friction fires fast (own short floor) — the colony is stuck, leap now.
  if (frictionTriggered) {
    if (elapsedSec >= minFrictionInterval) return { fire: true, reason: 'friction-triggered' };
    return { fire: false, reason: 'min-interval', retryAfterSec: Math.ceil(minFrictionInterval - elapsedSec) };
  }

  // 2. The normal floor guards idle/heartbeat fires.
  if (elapsedSec < minInterval) {
    return { fire: false, reason: 'min-interval', retryAfterSec: Math.ceil(minInterval - elapsedSec) };
  }

  // 3. Idle capacity — the fleet has room to explore.
  if (state.idleRatio >= idleThreshold) return { fire: true, reason: 'idle-capacity' };

  // 4. Heartbeat ceiling — don't let the loop stall forever under sustained load.
  if (maxInterval > 0 && elapsedSec >= maxInterval) return { fire: true, reason: 'heartbeat' };

  return { fire: false, reason: 'no-trigger' };
}

function nonNeg(v: number | undefined, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : dflt;
}
