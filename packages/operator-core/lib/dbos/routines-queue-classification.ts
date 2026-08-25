/**
 * routines-queue-classification.ts — which DBOS WorkflowQueue a scheduled-routine fire belongs on.
 *
 * Pure (no DBOS / side-effect imports) so it's unit-testable without booting the routine engine.
 *
 * WHY (2026-06-23 routines-queue-starvation incident): the single `routines` queue (concurrency 4) was
 * shared by SHORT critical routines (git-sync) AND LONG ones (green-checkpoint ~25m, gym ~90m, agent-role /
 * loop fires, …). A burst of ≥4 long routines holding every slot STARVED git-sync → no commits → all fleet
 * work + deploys frozen for 7h (and the bghost-watchdog mistook the starved queue for a frozen ticker and
 * restart-looped bg-host, killing green-checkpoint mid-run). The fix is two-pronged: the watchdog now
 * corroborates with the routinesTick SCHEDULER (so a busy queue is no longer read as a freeze), and — here —
 * git-sync gets a DEDICATED `routines-critical` lane so the shared queue's saturation can NEVER starve it.
 *
 * EI-21386288922867645 proves queueing a loop behind that shared backlog is NOT benign: a due loop fire sat
 * FIFO behind 29 earlier jobs for ~11 minutes, so the owner received no turn by its five-minute deadline.
 * Loop fires are quick but latency-sensitive, so they get their own bounded `routines-loop` lane. Git-sync
 * remains the ONLY action on `routines-critical`; long/unknown system actions and agent roles still default
 * to `routines`. This extends the existing queue mechanism without weakening its persistence invariant.
 */
import { SYSTEM_TARGET_PREFIX } from '../harness/routines/system-actions';

export const ROUTINES_QUEUE = 'routines';
export const ROUTINES_CRITICAL_QUEUE = 'routines-critical';
export const ROUTINES_LOOP_QUEUE = 'routines-loop';

/** Mirrors loop.ts's materialized target_role without importing that stateful module here. */
export const LOOP_WAKE_TARGET_ROLE = `${SYSTEM_TARGET_PREFIX}loop-wake`;

/**
 * System actions whose STARVATION freezes fleet-wide persistence/coordination → the protected lane.
 * `git-sync` is the proven case (its starvation behind 4 long routines froze every commit + deploys for 7h).
 * Add to this set ONLY a genuinely must-never-starve, QUICK action — never a long-running one (that would
 * re-create the starvation this lane exists to prevent).
 */
export const CRITICAL_ROUTINE_ACTIONS = new Set<string>(['git-sync']);

/**
 * The queue NAME a routine fire should enqueue on, by its target role. A loop wake → the latency-isolated
 * `routines-loop` lane; a critical quick SYSTEM action → `routines-critical`; everything else → `routines`.
 */
export function queueForRoutine(targetRole: string): string {
  if (targetRole === LOOP_WAKE_TARGET_ROLE) return ROUTINES_LOOP_QUEUE;
  if (
    targetRole.startsWith(SYSTEM_TARGET_PREFIX) &&
    CRITICAL_ROUTINE_ACTIONS.has(targetRole.slice(SYSTEM_TARGET_PREFIX.length))
  ) {
    return ROUTINES_CRITICAL_QUEUE;
  }
  return ROUTINES_QUEUE;
}

/**
 * The CRITICAL-ROUTINE FLOOR for the routinesTick PG-pool-starvation shed (EI-11171).
 *
 * When routinesTickImpl sheds on critical pool pressure (pool-pressure.ts), it must NOT go
 * fully dark: the ONE thing that can never be allowed to stall is the protected critical-queue
 * routine (git-sync) — the whole reason the dedicated `routines-critical` lane exists is that
 * its starvation froze every commit + deploy for 7h (2026-06-23). The original shed did a bare
 * `return` BEFORE the fire loop, silently skipping git-sync's enqueue too — defeating that lane.
 * This predicate is the floor: under a shed, a routine fires ONLY if it belongs to the protected
 * lane; everything else sheds with the heavy sweeps, exactly as before. Pure ⇒ unit-testable.
 */
export function shouldFireUnderPoolShed(targetRole: string): boolean {
  return queueForRoutine(targetRole) === ROUTINES_CRITICAL_QUEUE;
}
