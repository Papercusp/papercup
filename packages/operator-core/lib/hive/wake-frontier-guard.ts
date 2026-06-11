/**
 * wake-frontier-guard — the STRUCTURAL guard behind hive:declare-wake (EI-309).
 *
 * The Queen wedged a live autonomous loop by declaring an event-only ("subscribe
 * to work_items:create, place when created") wake while WI-116/WI-117 ALREADY
 * existed unplaced in her home harness — so with no time-wake and the items
 * sitting in `todo`/unassigned, nothing fired until an unrelated create or the 24h
 * watchdog. Root cause (EI-309 thread): she ran the decentralized-claim mental
 * model (pipeline workers self-claim) inside a Hive where SHE is the only
 * dispatcher — "steering" places nothing. The D-012/EI-286 lesson is that the
 * Queen's self-reports can't be trusted, so the fix is CODE, not just persona:
 * refuse a wake that has NO time component while the home harness still has
 * unplaced work, forcing her to either place it or arm a time-wake.
 *
 * Pure decider (`evaluateWakeFrontierGuard`) + the frontier query
 * (`listUnplacedHiveFrontier`), split so the decision unit-tests with no PG.
 */
import type postgres from 'postgres';

export interface WakeFrontierGuardInput {
  /** Whether the declaration sets a time component (`at`/`inSeconds`). A timer
   *  will re-wake the Queen to place work, so a frontier is fine then. */
  hasTimeWake: boolean;
  /** Unplaced (todo, unassigned) work-item ids in the home harness. */
  frontierIds: string[];
}

export interface WakeFrontierRefusal {
  error: 'frontier_not_empty';
  message: string;
  frontier: string[];
}

/**
 * Refuse a declaration with NO time component while the home harness has unplaced
 * work — that wake would never place it (in a Hive the Queen IS the dispatcher;
 * the claim layer is for harness pipelines, not the Hive). A time-wake or an empty
 * frontier passes. Returns the refusal, or null to allow.
 */
export function evaluateWakeFrontierGuard(input: WakeFrontierGuardInput): WakeFrontierRefusal | null {
  if (input.hasTimeWake) return null; // a timer re-wakes to place — fine
  if (input.frontierIds.length === 0) return null; // nothing to place
  const shown = input.frontierIds.slice(0, 10);
  const more = input.frontierIds.length - shown.length;
  return {
    error: 'frontier_not_empty',
    message:
      `Refusing an event-only/none wake: the home harness has ${input.frontierIds.length} unplaced todo work-item(s) ` +
      `(${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}) and no time-wake — an event-only/none wake will never ` +
      `place them (in a Hive YOU are the dispatcher; the claim layer is for harness pipelines, not the Hive). ` +
      `PLACE them this turn (spawn/dispatch a worker), or arm a time-wake (inSeconds/at) so you re-wake to place them. ` +
      `Pass force:true only if you deliberately intend to leave them unplaced.`,
    frontier: input.frontierIds,
  };
}

/**
 * The home harness's unplaced FRONTIER: feature-family work-items (feature /
 * research-task / chunk) that are `todo` and unassigned (`taken_by` null/empty) —
 * exactly what `claimNextWorkItem` would dispatch. Oldest-first, capped.
 */
export async function listUnplacedHiveFrontier(
  sql: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
  limit = 25,
): Promise<string[]> {
  const rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND item_kind IN ('feature', 'research-task', 'chunk')
       AND status = 'todo'
       AND (taken_by IS NULL OR taken_by = '')
     ORDER BY created_ts ASC
     LIMIT ${limit}`;
  return rows.map((r) => r.feature_id);
}
