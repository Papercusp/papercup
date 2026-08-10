/**
 * The host half of the goal stop seam — what actually happens when a goal moves to
 * `paused`, `killed` or `achieved` (EI-20013729460455061; `achieved` added by WI-37832,
 * which found the SUCCESS terminal was the one status that wound nothing down).
 *
 * Installed into `@papercusp/agent-mcp` at MODULE LOAD, the same way
 * capability-tier-overrides installs its resolver. It is imported from the
 * agent-tools index so loading the tool surface wires it; `stop-fanout-installed.test.ts`
 * fails if that import is ever dropped, because an uninstalled seam would restore
 * the exact silent no-op this module exists to remove.
 *
 * ── SCOPE, AND WHY IT IS NARROW ──────────────────────────────────────────────
 *
 * PLACEMENT is gated only on pots this goal OWNS. `goal_pots.role` is
 * load-bearing here (migration 765, D-019/D-021): `owner` is the single goal
 * permitted to place work into a pot, while a `contributing` link is driven by
 * a DIFFERENT goal's placement. Stopping a contributing pot would halt work
 * this goal does not own — so contributing links are listed in the report and
 * deliberately left running.
 *
 * LOOPS are disarmed only for sessions ATTRIBUTED to this goal — a GOAL-mode
 * `agent_modes` row whose `subject` is this goal id. The tempting alternative,
 * "disarm every active loop in the goal's pots", is a fleet-wide kill switch
 * fired by a label change: a goal's pot is routinely `papercusp` itself, where
 * dozens of unrelated su sessions hold active loops. Verified live 2026-08-09 —
 * `harness_shared.routines` carried many active `loop-su-*` rows on `install_slug =
 * 'papercusp'`, none of them belonging to any goal.
 *
 * ── WHY IT REPORTS WHAT IT DID NOT STOP ──────────────────────────────────────
 *
 * EI-19995648221353323 measured the failure this must not repeat: pot pause is a
 * placement GATE, not a throttle. It bounds new Mug placements and exerts zero
 * backpressure on sessions already alive with armed self-wake loops — so a pot read
 * "paused, maxBees 1" while 73 distinct owners ran it at 8-13k calls/hour and drained
 * the account pool to exhaustion. The steering surface reported a state that was not
 * the state of the system, and every downstream capacity decision was made on that
 * false premise.
 *
 * So this returns `unattributedActiveLoops`: active loops running in the goal's own
 * pots that could NOT be tied to the goal and were left alone. That is the
 * detector EI-19995648221353323 asks for, delivered at the moment the stop intent is
 * expressed rather than discovered days later from the pool. A caller that renders
 * only `status` will still be wrong — which is why `degraded` is set alongside it.
 */

import { getOrgPg, potsForGoal } from '@papercusp/db-org';
import {
  setGoalTransitionExecutor,
  isStoppingStatus,
  type GoalTransitionInput,
  type GoalTransitionReport,
  type GoalStopInput,
  type GoalStopReport,
  type GoalResumeReport,
} from '@papercusp/agent-mcp';
import { pausePotState, resumePotState } from '../pot/pause-core';
import { deactivateLoop, loopRoutineName } from '../harness/routines/loop';

/**
 * Session owner ids running GOAL mode for this goal. Presence of the row IS the
 * attribution: clearing a mode DELETEs it (modes/store.ts), so there is no enabled
 * flag to filter on.
 */
async function attributedOwners(
  sql: ReturnType<typeof getOrgPg>['sql'],
  workspaceId: string,
  goalId: string,
): Promise<string[]> {
  const rows = await sql<Array<{ owner_id: string }>>`
    SELECT DISTINCT owner_id
      FROM harness_shared.agent_modes
     WHERE workspace_id = ${workspaceId}
       AND mode = 'goal'
       AND subject = ${goalId}
       AND owner_id IS NOT NULL
  `;
  return rows.map((r) => r.owner_id);
}

/**
 * Active engine loops running in these pots that are NOT in `sparedNames`.
 * Counted AFTER the disarms so it reports what is still burning, not what was.
 */
async function countUnattributedActiveLoops(
  sql: ReturnType<typeof getOrgPg>['sql'],
  workspaceId: string,
  pots: string[],
  stoppedNames: string[],
): Promise<number> {
  if (pots.length === 0) return 0;
  const [row] = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n
      FROM harness_shared.routines
     WHERE workspace_id = ${workspaceId}
       AND install_slug = ANY(${pots})
       AND active = TRUE
       AND target_role = 'system:loop-wake'
       ${stoppedNames.length ? sql`AND name <> ALL(${stoppedNames})` : sql``}
  `;
  return row ? Number(row.n) : 0;
}

export async function executeGoalStop(input: GoalStopInput): Promise<GoalStopReport> {
  const { sql } = getOrgPg();
  const { goalId, workspaceId, status } = input;

  const links = await potsForGoal(sql, { workspaceId, goalId });
  const owned = links.filter((l) => l.role === 'owner').map((l) => l.harnessSlug);
  const contributing = links.filter((l) => l.role !== 'owner').map((l) => l.harnessSlug);

  // ── Tier 1: gate placement on the pots this goal owns ──────────────────────
  const potsStopped: string[] = [];
  for (const slug of owned) {
    await pausePotState(sql, workspaceId, slug);
    potsStopped.push(slug);
  }

  // ── Tier 2: disarm the loops of sessions attributed to this goal ───────────
  // This is the half with actual teeth: a placement gate alone leaves every live
  // self-waking session running (EI-19995648221353323).
  const owners = await attributedOwners(sql, workspaceId, goalId);
  const loopsStopped: string[] = [];
  for (const ownerId of owners) {
    // deactivateLoop is guarded `AND active = TRUE`, so a false return means the
    // session had no armed loop — not a failure.
    if (await deactivateLoop(ownerId, { sql })) loopsStopped.push(ownerId);
  }

  // ── The honest gap ─────────────────────────────────────────────────────────
  const unattributedActiveLoops = await countUnattributedActiveLoops(
    sql,
    workspaceId,
    owned,
    loopsStopped.map((o) => loopRoutineName(o)),
  );

  return {
    goalId,
    status,
    potsStopped,
    potsSkippedContributing: contributing,
    loopsStopped,
    unattributedActiveLoops,
    // Degraded when the stop is materially incomplete: we gated placement but real
    // burn continues in the goal's own pots.
    degraded: unattributedActiveLoops > 0,
  };
}

/**
 * Engine loops of sessions attributed to this goal that are currently DISARMED.
 *
 * A CURRENT-STATE measurement, not a replay of what the pause did — loop disarms have
 * no durable audit trail (`routine_loop_transitions` records only `parked`/`rearmed`,
 * measured 2026-08-09), so that table's silence about a disarm is not evidence of
 * anything. Rows that never existed are not counted: only a routine row that exists
 * and is inactive.
 */
async function countAttributedDisarmedLoops(
  sql: ReturnType<typeof getOrgPg>['sql'],
  owners: string[],
): Promise<number> {
  if (owners.length === 0) return 0;
  const names = owners.map((o) => loopRoutineName(o));
  const [row] = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n
      FROM harness_shared.routines
     WHERE name = ANY(${names})
       AND active = FALSE
  `;
  return row ? Number(row.n) : 0;
}

/**
 * The resume half (WI-37615, plan D-013). NOT the inverse of the stop, by design.
 *
 * It restores PLACEMENT on the pots this goal owns — the thing the pause gated and
 * that nothing else can un-gate, because `pausePotState` marks the pause `deliberate`
 * precisely so the recovery sweep leaves it alone. The fleet re-forms from placement.
 *
 * It deliberately does NOT re-arm the loops the pause disarmed. Those belong to
 * SESSIONS, which are routinely dead by the time a goal resumes; re-arming a dead
 * session's loop is meaningless and re-arming a live re-tasked one is worse. The count
 * is REPORTED instead — same contract as the stop's `unattributedActiveLoops`: a caller
 * that renders only `status` will be wrong, so hand it the number that says so.
 */
export async function executeGoalResume(input: GoalTransitionInput): Promise<GoalResumeReport> {
  const { sql } = getOrgPg();
  const { goalId, workspaceId } = input;

  const links = await potsForGoal(sql, { workspaceId, goalId });
  const owned = links.filter((l) => l.role === 'owner').map((l) => l.harnessSlug);
  const contributing = links.filter((l) => l.role !== 'owner').map((l) => l.harnessSlug);

  const potsResumed: string[] = [];
  for (const slug of owned) {
    await resumePotState(workspaceId, slug);
    potsResumed.push(slug);
  }

  const owners = await attributedOwners(sql, workspaceId, goalId);
  const loopsLeftDisarmed = await countAttributedDisarmedLoops(sql, owners);

  return {
    goalId,
    status: 'active',
    potsResumed,
    potsSkippedContributing: contributing,
    loopsLeftDisarmed,
    timeWakeRestored: false,
    // Degraded when the resume is materially incomplete: placement is open again but
    // sessions that were pursuing this goal are still not looping.
    degraded: loopsLeftDisarmed > 0,
  };
}

/** Route a status move to the arm that handles it. */
export async function executeGoalTransition(
  input: GoalTransitionInput,
): Promise<GoalTransitionReport> {
  return isStoppingStatus(input.status)
    ? executeGoalStop({ ...input, status: input.status })
    : executeGoalResume(input);
}

// Install at module load — the same seam pattern as capability-tier-overrides.
setGoalTransitionExecutor((input) => executeGoalTransition(input));
