/**
 * The host seam that gives `goals:update { status:'paused'|'killed' }` real teeth.
 *
 * WHY A SEAM AND NOT A DIRECT CALL. The dep direction is
 * operator-core -> agent-mcp -> tooldef, so a goals tool (which lives HERE) cannot
 * reach the two things that actually halt execution — the pot placement bit
 * (`pot/started`) and the engine-loop disarm (`harness/routines/loop`) — both of
 * which live up in operator-core. operator-core installs the real executor at
 * module load; until then a goal status write behaves exactly as it did before.
 * Same shape as the `setCapabilityTierOverride` seam in capability-tiers-papercusp.
 *
 * WHY THIS EXISTS AT ALL (EI-20013729460455061). `goals:update` was a pure record
 * write: SELECT -> UPDATE -> SELECT, no wake, no stop, no fan-out. Nothing outside
 * the goals tools reads `goals.status`, so pausing or killing a goal changed a
 * label and nothing else while the fleets, loops and pots pursuing it kept running.
 * The tool's own guidance said the projects "should have their projects wound down
 * first" — i.e. the wind-down was documented as a manual prerequisite.
 *
 * THE HONESTY REQUIREMENT (EI-19995648221353323). The measured failure one level
 * down is a stop control that REPORTS more than it does: pot pause is a placement
 * gate, not a throttle — it gates new Mug placements and exerts zero backpressure
 * on sessions already alive with armed self-wake loops. Measured 2026-08-09, a pot
 * read "paused, maxBees 1" while 73 distinct owners ran it at 8-13k calls/hour and
 * drained the account pool to exhaustion. So the report this seam returns MUST
 * distinguish what was actually stopped from what is still running and merely
 * un-attributable — see `unattributedActiveLoops`. A stop control that lets its
 * caller read "paused" as "burn stopped" is the bug, not the fix.
 */

/** What a goal stop did, per project and in total. Every field is a MEASUREMENT, not an intent. */
export interface GoalStopReport {
  /** The goal whose status moved. */
  goalId: string;
  /** The status it moved INTO — only 'paused' and 'killed' fan out. */
  status: 'paused' | 'killed';
  /**
   * Projects whose placement was gated, i.e. those this goal is the `owner` of.
   * A `contributing` link is deliberately NOT stopped: that project is driven by
   * a DIFFERENT goal's placement, and stopping it would halt work this goal does
   * not own (goal_projects role semantics, migration 765 D-019/D-021).
   */
  projectsStopped: string[];
  /** Live pairings this goal only contributes to — listed so the caller sees they were spared. */
  projectsSkippedContributing: string[];
  /**
   * Engine loops disarmed. Scoped to sessions ATTRIBUTED to this goal (a GOAL-mode
   * `agent_modes` row whose `subject` is this goal id) — never harness-wide, because
   * a goal's project is routinely the same harness dozens of unrelated su sessions
   * loop in, and disarming those would be a fleet-wide kill switch fired by a label change.
   */
  loopsStopped: string[];
  /**
   * ⚠ THE HONEST GAP. Active engine loops running IN this goal's owned projects that
   * could NOT be attributed to the goal, and were therefore left running. A non-zero
   * value means the goal is paused but real burn continues — the exact false-premise
   * state EI-19995648221353323 measured. Surfaced at the moment the intent is
   * expressed rather than discovered days later from the account pool.
   */
  unattributedActiveLoops: number;
  /**
   * True when the stop is materially incomplete: placement was gated but loops are
   * still burning in scope. Callers should render this, not just the status.
   */
  degraded: boolean;
}

export interface GoalStopInput {
  goalId: string;
  workspaceId: string;
  status: 'paused' | 'killed';
  /** The agent performing the stop, for the transition audit trail. */
  actor?: string | null;
}

export type GoalStopExecutor = (input: GoalStopInput) => Promise<GoalStopReport>;

let executor: GoalStopExecutor | undefined;

/**
 * Install (or clear, with `undefined`) the host executor. Called once by
 * operator-core at module load. Idempotent — a re-install replaces.
 */
export function setGoalStopExecutor(fn: GoalStopExecutor | undefined): void {
  executor = fn;
}

/** The installed executor, or undefined when the host has not wired one. */
export function getGoalStopExecutor(): GoalStopExecutor | undefined {
  return executor;
}

/** A goal status that triggers the stop fan-out. */
export function isStoppingStatus(status: string): status is 'paused' | 'killed' {
  return status === 'paused' || status === 'killed';
}
