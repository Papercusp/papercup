/**
 * work-items-stale-claims — release work-item claims held by DEAD agents.
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
 * Liveness rule — deliberately identical to migration 225's alias-aware
 * holder resolution (EI-311), so the sweep and the view can never disagree:
 * a claim's holder is ALIVE iff
 *   1. a coord_presence row with owner_id = taken_by has a heartbeat within
 *      the window, OR
 *   2. a RUNNING/RESTARTING spawned_agents row matches taken_by on ANY of its
 *      three aliases (spawn_id, session_owner, run_id) with a fresh nursery
 *      heartbeat.
 * Everything else past the grace window is presumed dead and released:
 * `taken_by/taken_at → NULL` (status untouched — a freed 'todo' is instantly
 * claimable again; rows a dead bee left in a non-claimable status are surfaced
 * in the result so the Queen/owner can re-place them deliberately).
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

type Db = Sql | TransactionSql;

/** How long a claim may sit heartbeat-less before it is presumed orphaned.
 *  Matches the fleet_assignment view's 10-minute liveness window (mig 225). */
export const STALE_CLAIM_GRACE_MS = 10 * 60 * 1000;

export interface ReleasedClaim {
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
  item_kind: string;
  /** The dead holder the claim was released from. */
  former_taken_by: string;
  /** The row's status at release time — non-'todo' rows need deliberate
   *  re-placement (the bee died mid-flight), so callers surface them. */
  status: string;
}

export interface StaleClaimSweepResult {
  released: ReleasedClaim[];
}

/**
 * Release every work-item claim whose holder is dead per the alias-aware
 * liveness rule. One atomic statement; returns the released rows (with their
 * former holder + status) for logging/re-placement.
 */
export async function reclaimStaleWorkItemClaims(
  sql: Db,
  opts: { graceMs?: number } = {},
): Promise<StaleClaimSweepResult> {
  const graceSec = Math.max(1, Math.round((opts.graceMs ?? STALE_CLAIM_GRACE_MS) / 1000));
  const rows = await sql<ReleasedClaim[]>`
    WITH live_holder AS (
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
         AND a.alias IS NOT NULL AND a.alias <> ''
    ),
    dead AS (
      SELECT f.workspace_id, f.harness_slug, f.feature_id, f.item_kind,
             f.taken_by AS former_taken_by, f.status
        FROM harness_shared.harness_features_consolidated f
       WHERE f.taken_by IS NOT NULL AND f.taken_by <> ''
         AND f.taken_at IS NOT NULL
         AND (now() - f.taken_at) > make_interval(secs => ${graceSec})
         AND NOT EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = f.taken_by)
         FOR UPDATE OF f SKIP LOCKED
    )
    UPDATE harness_shared.harness_features_consolidated f
       SET taken_by = NULL, taken_at = NULL, updated_ts = ${Date.now()}
      FROM dead d
     WHERE f.workspace_id = d.workspace_id
       AND f.harness_slug = d.harness_slug
       AND f.feature_id = d.feature_id
    RETURNING d.workspace_id, d.harness_slug, d.feature_id, d.item_kind,
              d.former_taken_by, d.status`;
  return { released: rows };
}
