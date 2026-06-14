/**
 * plan-items/stale-claims — release plan-item CLAIMS whose lease has lapsed AND
 * whose holder is gone (EI-179).
 *
 * The gap: a session claims a plan item → a heartbeat-leased `plan_item_claims`
 * row (mig 141). When the holder dies/vanishes, the lease lapses
 * (`expires_ts < now()`) but the row PHYSICALLY LINGERS — `acquireClaimLocal`
 * steals it LAZILY (the `ON CONFLICT … WHERE expires_ts <= clock_timestamp()`
 * overwrite), so nothing actively removes it until some OTHER agent happens to
 * re-claim that exact item. Abandoned items nobody re-claims accumulate as
 * "orphaned" rows (live lease, dead holder) — the fleet_assignment view can SEE
 * them, the expired-lease watchdog COUNTS them (→ EI-179, "abandoned work piling
 * up"), but nothing ACTED on them. This module is the missing actor — the
 * plan-item analog of `reclaimStaleWorkItemClaims` (work_items) that
 * `staleClaimSweepTick` already runs each minute.
 *
 * Why deleting a lapsed claim is safe (mig 141 lapse contract, D-003/D-004):
 *   - The CLAIM is only the live grip. The durable ASSIGNMENT (mig 140,
 *     plan_item_assignments) is a SEPARATE row and is untouched — so a reaped
 *     item returns to its assignee if assigned, else to the shared pool, which
 *     is exactly the designed lapse behaviour.
 *   - A live, turn-active holder's claims are renewed every turn
 *     (`renewOwnerActivityClaims`), so an EXPIRED claim already means the holder
 *     completed no turn for a full TTL. We still double-gate on holder liveness
 *     so a session mid-an-unusually-long single turn (turn > TTL, but still
 *     heartbeating coord_presence) is never robbed.
 *   - DELETE is the same operation a normal `releaseClaimLocal` performs; the
 *     table's NOTIFY trigger (mig 165) fires the fleet_assignment change-feed.
 *
 * Liveness rule — identical to `reclaimStaleWorkItemClaims` / the mig-225
 * alias-aware holder resolution, so the sweep and the fleet_assignment view can
 * never disagree about who is alive:
 *   1. a coord_presence row for `owner` with a heartbeat inside the grace
 *      window, OR
 *   2. a RUNNING/RESTARTING spawned_agents row matching `owner` on ANY of its
 *      three aliases (spawn_id / session_owner / run_id) with a fresh nursery
 *      heartbeat.
 *
 * Safety properties (mirror the work-item sweep):
 *   - graceMs (default 10 min) is required ON TOP of lease expiry: a claim must
 *     be lapsed for > grace AND its holder demonstrably gone. A briefly-quiet
 *     but alive session refreshes presence well inside the window.
 *   - FOR UPDATE … SKIP LOCKED — never blocks a live claim/heartbeat txn.
 *
 * Authority note: on a single box the claim authority is self, so this runs a
 * local DELETE — exactly as `releaseClaimLocal` / `renewOwnerActivityClaims`
 * already do. The cross-machine authority-routed sweep is hardware-gated
 * (distributed-coordination-shared-harness), same as the rest of the claim path.
 */

import type { Sql, TransactionSql } from 'postgres';

type Db = Sql | TransactionSql;

/** How long a claim's lease may stay lapsed (and its holder gone) before the
 *  sweep removes it. Matches the work-item sweep / fleet_assignment window. */
export const STALE_PLAN_CLAIM_GRACE_MS = 10 * 60 * 1000;

export interface ReleasedPlanClaim {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  item_id: string;
  /** The dead holder the claim was released from. */
  former_owner: string;
  /** Seconds the lease had been lapsed at reap time (for logging). */
  lapsed_secs: number;
}

export interface PlanClaimSweepResult {
  released: ReleasedPlanClaim[];
}

/**
 * Delete every plan-item claim whose lease lapsed > grace ago AND whose holder
 * is dead per the alias-aware liveness rule. One atomic statement; returns the
 * released rows (former holder + how long lapsed) for logging.
 */
export async function reclaimExpiredPlanItemClaims(
  sql: Db,
  opts: { graceMs?: number } = {},
): Promise<PlanClaimSweepResult> {
  const graceSec = Math.max(1, Math.round((opts.graceMs ?? STALE_PLAN_CLAIM_GRACE_MS) / 1000));
  const rows = await sql<ReleasedPlanClaim[]>`
    WITH live_holder AS (
      -- Mig-225 alias-aware liveness: fresh presence rows…
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
      SELECT c.workspace_id, c.harness_slug, c.plan_slug, c.item_id,
             c.owner AS former_owner,
             EXTRACT(EPOCH FROM (clock_timestamp() - c.expires_ts))::float8 AS lapsed_secs
        FROM harness_shared.plan_item_claims c
       WHERE c.expires_ts < clock_timestamp() - make_interval(secs => ${graceSec})
         AND NOT EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = c.owner)
         FOR UPDATE OF c SKIP LOCKED
    )
    DELETE FROM harness_shared.plan_item_claims c
      USING dead d
     WHERE c.workspace_id = d.workspace_id AND c.harness_slug = d.harness_slug
       AND c.plan_slug = d.plan_slug AND c.item_id = d.item_id
    RETURNING d.workspace_id, d.harness_slug, d.plan_slug, d.item_id,
              d.former_owner, d.lapsed_secs`;
  return { released: rows };
}
