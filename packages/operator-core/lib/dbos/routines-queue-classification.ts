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
 * Loop fires are quick but latency-sensitive, so they get their own bounded `routines-loop` lane. WI-41662
 * found the SAME shape a third time — the external-source polls (gmail/calendar/pr/vault) starved 4–18min
 * every hour behind green-checkpoint — so they get `routines-triggers` on the same principle. Git-sync
 * remains the ONLY action on `routines-critical`; long/unknown system actions and agent roles still default
 * to `routines`. This extends the existing queue mechanism without weakening its persistence invariant.
 */
import { SYSTEM_TARGET_PREFIX } from '../harness/routines/system-actions';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

export const ROUTINES_QUEUE = 'routines';
export const ROUTINES_CRITICAL_QUEUE = 'routines-critical';
export const ROUTINES_FLEET_CONTROL_QUEUE = 'routines-fleet-control';
export const ROUTINES_LOOP_QUEUE = 'routines-loop';
export const ROUTINES_TRIGGERS_QUEUE = 'routines-triggers';
export const ROUTINES_RELEASE_QUEUE = 'routines-release';

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
 * Fleet membership restoration is control-plane work whose latency determines
 * whether a leader can recover dead/stale lanes. It cannot share the ordinary
 * queue: a pool-pressure episode can leave dozens of older routine rows ahead
 * of a one-second headcount tick, delaying recovery for tens of minutes even
 * after the scheduler itself is healthy. It also cannot use the critical,
 * loop, trigger, or release lanes: a headcount action can open and attest agent
 * processes, so it is neither quick nor safe to put ahead of those consumers.
 * Keep this exact allow-list on its own serial queue.
 */
export const FLEET_CONTROL_ACTIONS = new Set<string>(['fleet-headcount-governor']);

/**
 * External-SOURCE poll actions → their own bounded lane. These are QUICK, run on a
 * sub-hour cadence, and their latency IS the product behaviour: an inbound email, PR,
 * or calendar event is not ingested until the poll actually executes.
 *
 * WI-41662 (2026-08-25) measured the starvation directly: on the shared `routines`
 * queue these sat FIFO behind green-checkpoint's hourly ~25m fire — 13 stalls in a
 * single day, 4m9s to 18m30s each, with gap ONSET clock-locked to :14–:16 past the
 * hour (green-checkpoint's cron is `0 15 * * * *`). Both Google polls froze and
 * resumed together, in the same process, while git-sync — the one routine with a
 * dedicated lane — ran straight through every gap. Nothing FAILED and nothing
 * restarted; the fires were merely waiting for a slot.
 *
 * Same starvation shape as the 2026-06-23 git-sync commit-freeze and
 * EI-21386288922867645's 11-minute loop-fire delay, so it gets the same proven
 * remedy rather than a new mechanism. Add ONLY quick, short-period external polls
 * here — a long-running action would re-create inside this lane the very starvation
 * the lane exists to prevent.
 */
export const TRIGGER_POLL_ACTIONS = new Set<string>([
  'google-gmail-poll',
  'google-calendar-poll',
  'pr-poll',
  'facebook-personal-vault-poll',
]);

/**
 * The queue NAME a routine fire should enqueue on, by its target role and (when
 * needed) install slug. The operator-home green-checkpoint is the workspace's
 * release finalizer: if it waits behind four long subject-hive gates, a frozen
 * repair queue cannot recover and every staging delivery remains blocked. Give
 * that one home-hive action its own serial lane; subject-hive checkpoints stay on
 * the bounded shared lane so their aggregate concurrency remains unchanged.
 *
 * A loop wake → the latency-isolated `routines-loop` lane; fleet restoration →
 * the serial `routines-fleet-control` lane; a critical quick SYSTEM action →
 * `routines-critical`; a quick external-source poll → `routines-triggers`; the
 * operator-home green-checkpoint → `routines-release`; everything else → `routines`.
 */
export function queueForRoutine(targetRole: string, installSlug?: string | null): string {
  if (targetRole === LOOP_WAKE_TARGET_ROLE) return ROUTINES_LOOP_QUEUE;
  if (targetRole.startsWith(SYSTEM_TARGET_PREFIX)) {
    const action = targetRole.slice(SYSTEM_TARGET_PREFIX.length);
    if (action === 'green-checkpoint' && installSlug === operatorHomeHarnessSlug()) {
      return ROUTINES_RELEASE_QUEUE;
    }
    if (FLEET_CONTROL_ACTIONS.has(action)) return ROUTINES_FLEET_CONTROL_QUEUE;
    if (CRITICAL_ROUTINE_ACTIONS.has(action)) return ROUTINES_CRITICAL_QUEUE;
    if (TRIGGER_POLL_ACTIONS.has(action)) return ROUTINES_TRIGGERS_QUEUE;
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
