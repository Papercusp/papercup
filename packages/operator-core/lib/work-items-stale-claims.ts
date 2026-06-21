/**
 * work-items-stale-claims — release work-item claims held by DEAD agents AND
 * requeue the mid-flight ones so they re-enter the claimable pool.
 *
 * The gap (owner-reported, 2026-06-11): a bee claims a work item →
 * `harness_features_consolidated.taken_by = <its alias>`. Bee identities are
 * per-spawn and NOT persisted — when the app closes/crashes, the bee's alias
 * never comes back, the row stays taken, and `claimNextWorkItem` (which
 * filters `taken_by IS NULL`) can never offer the item to anyone again. The
 * spawn-reclaim sweep (fleet/spawn-reclaim.ts) frees the CONCURRENCY slot of
 * a dead spawn but never touched its work-item claims; the fleet_assignment
 * view (migration 225) can *see* such claims as orphaned but nothing ACTED on
 * it. This module is the missing actor.
 *
 * GAP 1 (work-queue-stuck-item-recovery-2026-06-17, P-001/P-002/D-006/D-007):
 * clearing `taken_by` alone was not enough — `claimNextWorkItem` and the whole
 * dispatch frontier only consider `status = 'todo'`, so a row a dead bee left
 * at `in_progress`/`validating`/… became unclaimed-but-un-claimable: invisible
 * to self-selection AND to the hive demand signal, with no automated consumer
 * re-placing it on the NON-hive self-selection path (the hive path has its own
 * placement-watchdog + WI-222 reconcile). So the reaper now ALSO resets a freed
 * mid-flight row's status → `todo`, bounded by `requeue_count` (D-007): after
 * the cap (default 3) the row is dead-lettered to `blocked` instead of looping
 * a poison item. We reset to `todo`, NEVER `passed` — the reaper has no
 * completion signal (the holder is DEAD, work is genuinely incomplete); the
 * →`passed` polarity belongs to WI-222's clean-rc=0-exit path only (D-006).
 *
 * Liveness rule — deliberately identical to migration 225's alias-aware
 * holder resolution (EI-311), so the sweep and the view can never disagree:
 * a claim's holder is ALIVE iff
 *   1. a coord_presence row with owner_id = taken_by has a heartbeat within
 *      the window, OR
 *   2. a RUNNING/RESTARTING spawned_agents row matches taken_by on ANY of its
 *      three aliases (spawn_id, session_owner, run_id) with a fresh nursery
 *      heartbeat.
 * Everything else past the grace window is presumed dead and released. On
 * release: `taken_by/taken_at → NULL`; a mid-flight (requeueable) status is
 * reset → `todo` (or → `blocked` on cap exhaustion); terminal (`passed`/
 * `deprecated`) and `blocked` rows keep their status (terminal needs nothing,
 * `blocked` has its own delegator-notify path). The per-row `action` lets the
 * caller log requeues quietly and broadcast only the dead-letters.
 *
 * Safety properties:
 *   - graceMs (default 10 min, the view's window) means a briefly-quiet but
 *     alive agent is never robbed: its presence/nursery heartbeats refresh
 *     well inside the window.
 *   - FOR UPDATE SKIP LOCKED — never blocks a live claim transaction.
 *   - The release UPDATE re-checks the same predicates, so a row re-claimed
 *     between snapshot and update is left alone.
 *
 * Wired as a periodic DBOS sweep beside spawn-reclaim (periodic-workflows.ts).
 */

import type { Sql, TransactionSql } from 'postgres';
import { STALE_MS } from './liveness';
import {
  FEATURE_NON_REQUEUE_STATES,
  isRequeueableFeatureState,
  staleReclaimRequeueCap,
} from './work-item-dispatch-states';

type Db = Sql | TransactionSql;

/** How long a claim may sit heartbeat-less before it is presumed orphaned.
 *  Matches the fleet_assignment view's 10-minute liveness window (mig 225). */
export const STALE_CLAIM_GRACE_MS = STALE_MS;

/** What the reaper did to a freed row. */
export type StaleClaimAction =
  /** Mid-flight row reset → `todo`, back in the claimable pool. */
  | 'requeued'
  /** Requeue cap reached → parked in `blocked` (poison item, needs attention). */
  | 'dead-lettered'
  /** Row was already `todo` — only `taken_by` cleared. */
  | 'freed-todo'
  /** Row was terminal (`passed`/`deprecated`) — only `taken_by` cleared (no re-placement). */
  | 'freed-terminal'
  /** Row was `blocked` — only `taken_by` cleared; its own signal path handles it. */
  | 'freed-blocked';

export interface ReleasedClaim {
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
  item_kind: string;
  /** The dead holder the claim was released from. */
  former_taken_by: string;
  /** The row's status BEFORE the sweep. */
  former_status: string;
  /** The row's status AFTER the sweep (todo / blocked / unchanged). */
  new_status: string;
  /** The requeue counter AFTER the sweep. */
  requeue_count: number;
  /** What the reaper did — derived, drives caller logging/broadcast. */
  action: StaleClaimAction;
}

export interface StaleClaimSweepResult {
  released: ReleasedClaim[];
}

interface ReleasedRow {
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
  item_kind: string;
  former_taken_by: string;
  former_status: string;
  new_status: string;
  requeue_count: number;
}

/** Classify a freed row from its former/new status + counter. */
function classify(row: ReleasedRow, cap: number): StaleClaimAction {
  if (isRequeueableFeatureState(row.former_status)) {
    return row.requeue_count >= cap ? 'dead-lettered' : 'requeued';
  }
  if (row.former_status === 'blocked') return 'freed-blocked';
  if (row.former_status === 'todo' || row.former_status === '' || row.former_status == null) return 'freed-todo';
  return 'freed-terminal';
}

/**
 * The mig-225 alias-aware "live holder" set as an embeddable postgres fragment —
 * owners with a FRESH coord_presence heartbeat, UNION every alias (spawn_id /
 * session_owner / run_id) of a RUNNING/RESTARTING nursery row with a fresh
 * heartbeat. Shared by BOTH the feature reaper and the issue reaper (P-005) so
 * their liveness rule can NEVER diverge — embed it in a `WITH live_holder AS (…)`.
 */
export function liveHolderFragment(sql: Db, graceSec: number) {
  return sql`
      -- Mig-225 alias-aware liveness: presence rows…
      SELECT owner_id AS alias
        FROM harness_shared.coord_presence
       WHERE heartbeat_at IS NOT NULL
         AND (now() - heartbeat_at) < make_interval(secs => ${graceSec})
      UNION
      -- …plus every alias of a RUNNING nursery row with a fresh heartbeat.
      SELECT a.alias
        FROM harness_shared.spawned_agents n
        CROSS JOIN LATERAL (VALUES (n.spawn_id), (n.session_owner), (n.run_id)) AS a(alias)
       WHERE n.status IN ('running', 'restarting')
         AND n.heartbeat_at IS NOT NULL
         AND (now() - n.heartbeat_at) < make_interval(secs => ${graceSec})
         AND a.alias IS NOT NULL AND a.alias <> ''`;
}

/**
 * Release every work-item claim whose holder is dead per the alias-aware
 * liveness rule, and requeue the mid-flight ones (bounded by the requeue cap).
 * One atomic statement; returns the released rows (with former/new status,
 * counter, and a derived action) for logging/broadcast.
 */
export async function reclaimStaleWorkItemClaims(
  sql: Db,
  opts: { graceMs?: number; requeueCap?: number } = {},
): Promise<StaleClaimSweepResult> {
  const graceSec = Math.max(1, Math.round((opts.graceMs ?? STALE_CLAIM_GRACE_MS) / 1000));
  const cap = opts.requeueCap ?? staleReclaimRequeueCap();
  const nonRequeue = [...FEATURE_NON_REQUEUE_STATES];
  const rows = await sql<ReleasedRow[]>`
    WITH live_holder AS (${liveHolderFragment(sql, graceSec)}),
    dead AS (
      SELECT f.workspace_id, f.harness_slug, f.feature_id, f.item_kind,
             f.taken_by AS former_taken_by, f.status AS former_status,
             f.requeue_count AS former_requeue_count
        FROM harness_shared.harness_features_consolidated f
       WHERE f.taken_by IS NOT NULL AND f.taken_by <> ''
         AND f.taken_at IS NOT NULL
         AND (now() - f.taken_at) > make_interval(secs => ${graceSec})
         AND NOT EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = f.taken_by)
         FOR UPDATE OF f SKIP LOCKED
    )
    UPDATE harness_shared.harness_features_consolidated f
       SET taken_by = NULL,
           taken_at = NULL,
           -- Requeueable (mid-flight) rows bump the counter; everything else holds.
           requeue_count = CASE
             WHEN d.former_status <> ALL(${nonRequeue}::text[])
               THEN d.former_requeue_count + 1
             ELSE d.former_requeue_count END,
           -- Mid-flight → todo, or → blocked once the (incremented) counter hits
           -- the cap (dead-letter). Terminal / blocked / todo rows keep status.
           status = CASE
             WHEN d.former_status <> ALL(${nonRequeue}::text[])
               THEN (CASE WHEN d.former_requeue_count + 1 >= ${cap} THEN 'blocked' ELSE 'todo' END)
             ELSE d.former_status END,
           updated_ts = ${Date.now()}
      FROM dead d
     WHERE f.workspace_id = d.workspace_id
       AND f.harness_slug = d.harness_slug
       AND f.feature_id = d.feature_id
    RETURNING d.workspace_id, d.harness_slug, d.feature_id, d.item_kind,
              d.former_taken_by, d.former_status,
              f.status AS new_status, f.requeue_count AS requeue_count`;
  return {
    released: rows.map((r) => ({
      workspace_id: r.workspace_id,
      harness_slug: r.harness_slug,
      feature_id: r.feature_id,
      item_kind: r.item_kind,
      former_taken_by: r.former_taken_by,
      former_status: r.former_status,
      new_status: r.new_status,
      requeue_count: r.requeue_count,
      action: classify(r, cap),
    })),
  };
}

/** An issue-family (bug/change) claim freed from a dead holder. */
export interface ReleasedIssueClaim {
  workspace_id: string;
  issue_id: string;
  kind: string;
  /** The dead holder the issue was unassigned from. */
  former_assignee: string;
  /** The delegator (assigned_by), if any — carried for symmetry/logging; bug/change
   *  are self-selected so this is usually null. */
  assigned_by: string | null;
}

export interface StaleIssueSweepResult {
  released: ReleasedIssueClaim[];
}

/**
 * Issue-family stale-claim reaper (GAP 2, P-005 / D-009). Clears `assignee`/
 * `assigned_at` on OPEN `bug`/`change` issues whose holder is dead per the SAME
 * alias-aware liveness rule as the feature reaper (shared {@link liveHolderFragment}),
 * returning them to the `open` claimable pool.
 *
 * `task` (delegate) issues are DELIBERATELY EXCLUDED (D-009): a delegate's
 * `assignee = 'delegate:<agentSessionId>'` is a durable CONVERSATIONAL binding
 * (runId == agentSessionId, dormant between turns, `assigned_at` stamped once at
 * creation), NOT a heartbeating work-claim — so staleness reaping would strand a
 * resumable owner conversation. One atomic statement; returns the reaped rows.
 */
export async function reclaimStaleIssueClaims(
  sql: Db,
  opts: { graceMs?: number } = {},
): Promise<StaleIssueSweepResult> {
  const graceSec = Math.max(1, Math.round((opts.graceMs ?? STALE_CLAIM_GRACE_MS) / 1000));
  const released = await sql<ReleasedIssueClaim[]>`
    WITH live_holder AS (${liveHolderFragment(sql, graceSec)}),
    dead AS (
      SELECT e.workspace_id, e.issue_id, e.kind,
             e.assignee AS former_assignee, e.assigned_by
        FROM harness_shared.engineer_issues e
       WHERE e.assignee IS NOT NULL AND e.assignee <> ''
         AND e.assigned_at IS NOT NULL
         AND (now() - e.assigned_at) > make_interval(secs => ${graceSec})
         AND e.state = 'open'
         AND e.kind IN ('bug', 'change')   -- D-009: exclude task (delegate binding)
         AND NOT EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = e.assignee)
         FOR UPDATE OF e SKIP LOCKED
    )
    UPDATE harness_shared.engineer_issues e
       SET assignee = NULL, assigned_at = NULL, origin = 'local'
      FROM dead d
     WHERE e.workspace_id = d.workspace_id AND e.issue_id = d.issue_id
    RETURNING d.workspace_id, d.issue_id, d.kind, d.former_assignee, d.assigned_by`;
  return { released };
}
