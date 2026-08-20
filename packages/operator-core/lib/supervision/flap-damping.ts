/**
 * Shared restart flap damping.
 *
 * This is deliberately free of systemd, goal, process, and persistence concepts. A caller owns
 * the identity and storage for one target; this module owns only the restart cadence and give-up
 * policy. The systemd unit reconciler and goal-holder recovery therefore cannot drift onto
 * different backoff/reset semantics (goal-live-holder-guarantee-2026-08-18 P-008).
 */

/** Backoff ladder in seconds, indexed by consecutive restart-attempt count (capped). */
export const BACKOFF_SEQUENCE_SEC: readonly number[] = [1, 5, 15, 60];
/** At least this many restarts inside GIVE_UP_WINDOW_MS stops further restart attempts. */
export const GIVE_UP_THRESHOLD = 6;
export const GIVE_UP_WINDOW_MS = 10 * 60 * 1000;
/** Continuously healthy this long resets the restart counter and give-up latch. */
export const HEALTHY_RESET_MS = 5 * 60 * 1000;

/**
 * Runtime-only damping state for one caller-owned target.
 *
 * Identity is intentionally not stored here: callers key this state by unit name, goal id, or
 * another stable target id. Keeping the state structural makes the policy reusable without
 * importing either consumer's domain model.
 */
export interface FlapDampingState {
  /** Restart-attempt timestamps (epoch ms), pruned to the trailing give-up window. */
  restarts: number[];
  /** Index into BACKOFF_SEQUENCE_SEC for the next restart attempt. */
  backoffIndex: number;
  lastRestartAt: number | null;
  /** Epoch ms the target was first observed continuously healthy; null while unhealthy. */
  healthySince: number | null;
  /** No further attempts until a full healthy-reset window clears this latch. */
  gaveUp: boolean;
}

export function initialFlapDampingState(): FlapDampingState {
  return {
    restarts: [],
    backoffIndex: 0,
    lastRestartAt: null,
    healthySince: null,
    gaveUp: false,
  };
}

export type FlapDampingAction =
  | { kind: 'healthy'; reset: boolean }
  | { kind: 'waiting-backoff' }
  | { kind: 'already-escalated' }
  | { kind: 'restart'; backoffSec: number }
  | { kind: 'escalate-give-up'; restartsInWindow: number };

export interface FlapDampingInput {
  healthy: boolean;
  state: FlapDampingState;
  now: number;
}

/**
 * Pure decision for one target. The caller persists `nextState` and performs a returned restart
 * or escalation; this function never performs I/O.
 */
export function decideFlapDamping(input: FlapDampingInput): { action: FlapDampingAction; nextState: FlapDampingState } {
  const state = { ...input.state };

  if (input.healthy) {
    if (state.healthySince == null) state.healthySince = input.now;
    const reset = (state.gaveUp || state.restarts.length > 0) && input.now - state.healthySince >= HEALTHY_RESET_MS;
    if (reset) {
      state.gaveUp = false;
      state.restarts = [];
      state.backoffIndex = 0;
      state.lastRestartAt = null;
    }
    return { action: { kind: 'healthy', reset }, nextState: state };
  }

  state.healthySince = null;
  if (state.gaveUp) {
    return { action: { kind: 'already-escalated' }, nextState: state };
  }

  if (state.lastRestartAt != null) {
    // backoffIndex advances after an attempt, so spacing uses the prior rung.
    const priorIndex = Math.max(0, state.backoffIndex - 1);
    const priorWaitSec = BACKOFF_SEQUENCE_SEC[Math.min(priorIndex, BACKOFF_SEQUENCE_SEC.length - 1)];
    if (input.now - state.lastRestartAt < priorWaitSec * 1000) {
      return { action: { kind: 'waiting-backoff' }, nextState: state };
    }
  }

  const pruned = state.restarts.filter((at) => input.now - at < GIVE_UP_WINDOW_MS);
  if (pruned.length >= GIVE_UP_THRESHOLD) {
    state.gaveUp = true;
    state.restarts = pruned;
    return {
      action: { kind: 'escalate-give-up', restartsInWindow: pruned.length },
      nextState: state,
    };
  }

  const backoffSec = BACKOFF_SEQUENCE_SEC[Math.min(state.backoffIndex, BACKOFF_SEQUENCE_SEC.length - 1)];
  state.restarts = [...pruned, input.now];
  state.backoffIndex = Math.min(state.backoffIndex + 1, BACKOFF_SEQUENCE_SEC.length - 1);
  state.lastRestartAt = input.now;
  return { action: { kind: 'restart', backoffSec }, nextState: state };
}
