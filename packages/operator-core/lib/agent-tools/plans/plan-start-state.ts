/**
 * Cross-field invariant: a plan that is operationally `started`/`paused`
 * (`harness_shared.harness_plans.op_status`) must NEVER also be at a terminal
 * lifecycle status (`shipped` / `superseded`) in its frontmatter.
 *
 * Both now live in the same `harness_plans` row (op_status column + the
 * frontmatter `status` index derived from `content`), but a column `CHECK`
 * still can't express the rule cheaply across the parsed-vs-stored boundary,
 * so we enforce it at the write boundary + on read:
 *
 *   1. Every lifecycle transition to a terminal status clears the PG
 *      started/paused row (→ 'done') — {@link clearStartedForTerminalPlan},
 *      called from set-plan-status / set-content / set-content-chunk /
 *      set-frontmatter.
 *   2. `plans:start` refuses a plan whose frontmatter is already terminal —
 *      {@link isTerminalPlanStatus}.
 *   3. `plans:list` self-heals a stale started+terminal row on read —
 *      {@link reconcileStartStatus} — so even a raw `.md` edit that bypassed
 *      every verb can't surface a terminal plan as "waiting".
 *
 * The net effect: the "N plans waiting" badge, the Running bucket chip, and
 * the plan rail all derive "waiting/running" from the same started set, and
 * a started plan can never simultaneously be shipped/superseded.
 */

import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

export type StartStatus = 'started' | 'paused' | 'done' | null;

/** Terminal plan-lifecycle statuses — a started plan can never be one of these. */
export const TERMINAL_PLAN_STATUSES = ['shipped', 'superseded'] as const;

/** True when the frontmatter lifecycle status is terminal (shipped/superseded). */
export function isTerminalPlanStatus(status: string | null | undefined): boolean {
  return status === 'shipped' || status === 'superseded';
}

/**
 * Reconcile the operational start-status reported to a reader against the
 * plan's lifecycle status. A terminal plan can never be `started`/`paused`;
 * if a stale PG row says it is (e.g. a raw `.md` edit that bypassed the
 * write verbs), report `'done'` instead. Pure — used by `plans:list`.
 */
export function reconcileStartStatus(startStatus: StartStatus, lifecycleStatus: string | null | undefined): StartStatus {
  if ((startStatus === 'started' || startStatus === 'paused') && isTerminalPlanStatus(lifecycleStatus)) {
    return 'done';
  }
  return startStatus;
}

/**
 * Clear a plan's operational started/paused row when its lifecycle goes
 * terminal: set `status='done'` (the row is preserved so started_at /
 * priority history survives). Idempotent — only touches an active row, so
 * a no-op for plans that were never started. Best-effort by design: the
 * caller's file write has already succeeded, and {@link reconcileStartStatus}
 * recovers a missed clear on the next read.
 *
 * @returns `{ cleared }` — whether an active row was transitioned.
 */
export async function clearStartedForTerminalPlan(
  harnessSlug: string,
  planSlug: string,
): Promise<{ cleared: boolean }> {
  const now = new Date().toISOString();
  // ⚠ WI-5125 class (EI-16183): harness_plans is keyed on (workspace_id,
  // harness_slug, plan_slug) — workspace_id is only knowable in-process via
  // activeWorkspaceId(). The old literal DEFAULT_WORKSPACE_ID matched ZERO
  // rows for any non-default tenant, so a plan going terminal never cleared
  // its started/paused row (best-effort by design, but silently so — a
  // terminal plan could keep reporting started/paused until the next
  // plans:list self-heal).
  const workspaceId = activeWorkspaceId();
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ plan_slug: string }[]>`
      UPDATE harness_shared.harness_plans
         SET op_status = 'done', op_updated_at = ${now}
       WHERE workspace_id = ${workspaceId}
         AND harness_slug  = ${harnessSlug}
         AND plan_slug     = ${planSlug}
         AND op_status IN ('started', 'paused')
      RETURNING plan_slug
    `;
  });
  return { cleared: rows.length > 0 };
}
