/**
 * queen-warm-session — L2 of queen-memory-hybrid-2026-07-02 (owner-approved hybrid).
 *
 * Under FLAGS.QUEEN_WARM_SESSION the queen's wakes prefer the wake-executor
 * liveness ladder (inject-if-live / `claude --resume`-if-exited — the proven
 * B-LOOP-3 machinery that keeps su engine-loop sessions warm) over a cold
 * invoke-once spawn: continuity + prompt-cache warmth by default. This module is
 * the DETERMINISTIC REBIRTH decider — the safety valve that bounds
 * summary-drift/poisoning and keeps the restart-tolerance that makes
 * fresh-per-turn safe. A rebirth is NOT an error path: it falls through to the
 * cold spawn (today's exact behavior), and the brief + carry-journal + standing
 * facts make it cost warmth, never correctness.
 *
 * PURE — unit-tested with no IO; the wake chokepoint supplies the inputs.
 */

/** Max warm-session age before a scheduled rebirth (L2b). */
export const QUEEN_SESSION_MAX_AGE_MS = 24 * 3600 * 1000;

export type QueenWakeMode = 'warm' | 'rebirth' | 'cold';

export interface QueenRebirthInputs {
  /** Boot id recorded when the warm session was born. */
  sessionBootId: string | null;
  /** The host's current boot id. */
  currentBootId: string | null;
  /** ms epoch when the warm session was born. */
  sessionStartedMs: number | null;
  nowMs: number;
  /** The queen's autoloop consecutive_errors (anomaly signal). */
  consecutiveErrors?: number;
  /** The latest hive-coordination-health scorecard is red / missing (anomaly). */
  scorecardUnhealthy?: boolean;
}

/** Why a rebirth (or cold start) was chosen — stamped into the wake-mode metric. */
export interface QueenWakeDecision {
  mode: QueenWakeMode;
  reason: string;
}

/**
 * Decide warm-resume vs rebirth for a queen wake. `cold` = no resumable session
 * exists at all (first wake / caller found nothing to resume). Rebirth wins on
 * ANY of: boot-id change (the process world restarted under the session),
 * session older than {@link QUEEN_SESSION_MAX_AGE_MS}, or an anomaly signal
 * (error streak / unhealthy scorecard) — a struggling warm session must never
 * be resumed into, that is how drift compounds.
 */
export function decideQueenWakeMode(inputs: QueenRebirthInputs): QueenWakeDecision {
  if (!inputs.sessionBootId || inputs.sessionStartedMs == null) {
    return { mode: 'cold', reason: 'no resumable session recorded' };
  }
  if (inputs.currentBootId && inputs.sessionBootId !== inputs.currentBootId) {
    return { mode: 'rebirth', reason: `boot-id changed (${inputs.sessionBootId} → ${inputs.currentBootId})` };
  }
  const age = inputs.nowMs - inputs.sessionStartedMs;
  if (age >= QUEEN_SESSION_MAX_AGE_MS) {
    return { mode: 'rebirth', reason: `session age ${Math.round(age / 3600_000)}h ≥ 24h scheduled rebirth` };
  }
  if ((inputs.consecutiveErrors ?? 0) > 0) {
    return { mode: 'rebirth', reason: `anomaly: consecutive_errors=${inputs.consecutiveErrors}` };
  }
  if (inputs.scorecardUnhealthy === true) {
    return { mode: 'rebirth', reason: 'anomaly: hive-coordination-health unhealthy' };
  }
  return { mode: 'warm', reason: 'resumable session healthy + fresh' };
}
