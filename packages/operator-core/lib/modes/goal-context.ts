/**
 * goal-context — the ONE answer to "which goal does this agent's work serve?"
 * (goal-mode-hardening-2026-08-10 P-002, D-008).
 *
 * WHY THIS IS NOT `getModeSubject(ws, owner, 'goal')`. It used to be. Goal
 * provenance (`work_items.goal_id`) was stamped by reading the creator's own
 * GOAL-mode subject, which is correct for exactly one agent — the one RUNNING
 * the goal — and silently wrong for everyone it spawns. A fleet member launched
 * by a goal agent has no goal-mode row, so every work-item it created stamped
 * NULL and fell out of the goal's spend meter and its "what belongs to this
 * goal?" view. The goal agent's own handful of items were counted; the fleet
 * doing the actual work was invisible.
 *
 * The fix is NOT to give the child a goal-mode row. That would make it a
 * portfolio manager (`isGoalSessionModes()` true), hide it from the ordinary
 * sessions board, and hand it GOAL's never-implement contract — the thing P-002
 * names explicitly: "a fleet member must not become a portfolio manager". The
 * two facts were only ever conflated because, before fleets, the only session
 * that created work under a goal WAS the goal's agent:
 *
 *   agent_modes.subject (mode='goal')  -> this session RUNS the goal
 *   session_briefs.goal_id             -> this session's WORK BELONGS TO the goal
 *
 * TRANSITIVITY IS A PROPERTY OF THE RESOLVER, not of the launch code. A launch
 * injects the LAUNCHER's *resolved* context (this function), not its mode
 * subject — so a child that inherited resolves the same goal, and ITS children
 * inherit it in turn. Nothing special-cases depth; "descendants" falls out.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { getModeSubject } from './store';
import { GOAL_MODE } from './goal-session';

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

/**
 * The goal id INHERITED by this agent from its launcher, or null.
 *
 * Deliberately separate from {@link resolveGoalContext} so a caller that needs
 * to know *how* an agent is attached to a goal (ran it vs inherited it) can ask
 * without re-deriving the precedence, and so the fallback leg is testable on its
 * own.
 *
 * Fail-soft to null on ANY error, including the "column does not exist" a node
 * that has not yet applied migration 785 will raise: every caller is a stamping
 * or launch path where the correct behaviour when provenance cannot be resolved
 * is to record none, never to fail the operation it was decorating.
 */
export async function getInheritedGoalContext(
  workspaceId: string,
  ownerId: string,
  sql?: Sql,
): Promise<string | null> {
  if (!workspaceId || workspaceId === '*' || !ownerId) return null;
  try {
    const rows = await pg(sql)`
      SELECT goal_id FROM harness_shared.session_briefs
      WHERE owner_id = ${ownerId} AND workspace_id = ${workspaceId}
      LIMIT 1`;
    const raw = rows.length ? (rows[0] as { goal_id?: unknown }).goal_id : null;
    return raw == null || raw === '' ? null : String(raw);
  } catch {
    return null;
  }
}

/**
 * Record that `ownerId` works under `goalId`, inherited from its launcher.
 *
 * A NARROW writer rather than `writeSessionBrief({ goalId })` on purpose. That
 * function assigns `owner_label`, `source` and `intent` unconditionally in its
 * ON CONFLICT clause — correct for a presence write, destructive here: a
 * carry-respawn reuses the SAME ownerId, so the brief row already exists and
 * carries the predecessor's declared intent, which is exactly the field a
 * successor reads first. This touches `goal_id` and nothing else.
 *
 * The INHERITED value wins over an existing one. Launch is an explicit act, and
 * an agent relaunched by a different goal's agent has genuinely been re-parented
 * — the alternative (populate-once-then-keep, as the other lanes use) would pin
 * a recycled owner id to a goal that no longer owns it.
 *
 * Fail-soft: a launch must never fail because provenance could not be recorded.
 * Returns whether the write landed, so a caller can log the miss instead of
 * assuming success.
 */
export async function setInheritedGoalContext(
  workspaceId: string,
  ownerId: string,
  goalId: string,
  sql?: Sql,
): Promise<boolean> {
  if (!workspaceId || workspaceId === '*' || !ownerId || !goalId) return false;
  try {
    await pg(sql)`
      INSERT INTO harness_shared.session_briefs
        (owner_id, workspace_id, goal_id, first_seen_at, updated_at)
      VALUES (${ownerId}, ${workspaceId}, ${goalId}, now(), now())
      ON CONFLICT (owner_id) DO UPDATE SET
        goal_id    = EXCLUDED.goal_id,
        updated_at = now()`;
    return true;
  } catch {
    return false;
  }
}

/**
 * The goal this agent's work serves — the single resolution every provenance
 * stamp and every launch-time inheritance goes through.
 *
 * Precedence is load-bearing and is the reason this is one function rather than
 * two call sites doing `?? `: an agent that is BOTH running a goal and was
 * launched under another one must attribute its work to the goal it runs. That
 * is reachable today — a goal agent spawned by a higher-level goal agent — and
 * the opposite order would silently re-parent a whole sub-portfolio's work to
 * its grandparent.
 */
export async function resolveGoalContext(
  workspaceId: string,
  ownerId: string,
  sql?: Sql,
): Promise<string | null> {
  if (!workspaceId || workspaceId === '*' || !ownerId) return null;
  try {
    const own = await getModeSubject(workspaceId, ownerId, GOAL_MODE, sql);
    if (own) return own;
  } catch {
    /* fall through to the inherited leg — a mode-store failure must not cost
       provenance an agent legitimately inherited. */
  }
  return getInheritedGoalContext(workspaceId, ownerId, sql);
}
