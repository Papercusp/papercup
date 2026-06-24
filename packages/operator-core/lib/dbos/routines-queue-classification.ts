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
 * Kept deliberately MINIMAL: only actions whose starvation halts fleet-wide PERSISTENCE/coordination belong
 * in the protected lane. Everything else (agent-role spawns, loops, long/unknown system actions) stays on
 * the shared `routines` queue — it may queue under load, but that's now benign (no commit-freeze, no
 * watchdog false-restart). A NEW routine therefore defaults to the shared queue, so it can never silently
 * starve the protected lane.
 */
import { SYSTEM_TARGET_PREFIX } from '../harness/routines/system-actions';

export const ROUTINES_QUEUE = 'routines';
export const ROUTINES_CRITICAL_QUEUE = 'routines-critical';

/**
 * System actions whose STARVATION freezes fleet-wide persistence/coordination → the protected lane.
 * `git-sync` is the proven case (its starvation behind 4 long routines froze every commit + deploys for 7h).
 * Add to this set ONLY a genuinely must-never-starve, QUICK action — never a long-running one (that would
 * re-create the starvation this lane exists to prevent).
 */
export const CRITICAL_ROUTINE_ACTIONS = new Set<string>(['git-sync']);

/**
 * The queue NAME a routine fire should enqueue on, by its target role. A critical quick SYSTEM action → the
 * protected `routines-critical` lane; everything else → the shared `routines` queue.
 */
export function queueForRoutine(targetRole: string): string {
  if (
    targetRole.startsWith(SYSTEM_TARGET_PREFIX) &&
    CRITICAL_ROUTINE_ACTIONS.has(targetRole.slice(SYSTEM_TARGET_PREFIX.length))
  ) {
    return ROUTINES_CRITICAL_QUEUE;
  }
  return ROUTINES_QUEUE;
}
