/**
 * issue-blocks merge — projects open blocking issues onto plan items
 * (engineer-issues-2026-06-03, Phase 2 / D-005).
 *
 * An issue blocks a plan item via a coord_links edge (rel='blocks',
 * src=issue:<id>, dst=plan_item:'<plan_slug>#<item_id>'), written by issues:link.
 * The edge is NOT in plan markdown — closing the issue unblocks every target
 * atomically (one row flip). This reads those edges + the issues' Lifecycle state
 * and returns the item ids with ≥1 OPEN blocking issue, so the plans:* operator
 * readers (plans:get/list/items) can override an item's effectiveStatus
 * todo→blocked AFTER the pure resolver runs — the exact post-resolution merge
 * pattern plans:get already uses for feature-links. The pure @papercusp/plan-parser
 * resolver is UNCHANGED; this merge lives only at the operator call-site.
 *
 * Wiring note: the call-sites that consume this (plans:get/list/items) are being
 * rewritten FS→PG by plans-pg-canonical (su-fcb0d); the one-line merge call is
 * added there once that cutover settles. This module + its test are independent.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';

export const PLAN_ITEM_KIND = 'plan_item';

/** The coord_links dst_ref for a plan item: '<plan_slug>#<item_id>'. */
export function planItemRef(planSlug: string, itemId: string): string {
  return `${planSlug}#${itemId}`;
}

export interface BlockingInfo {
  /** item id (e.g. 'P-003') → the open blocking issue ids. Absent = not blocked. */
  blockedItems: Map<string, string[]>;
}

/**
 * For one plan, the items that have ≥1 OPEN blocking issue + which issues block
 * them. A resolved/closed issue no longer blocks. Pure read over PG.
 */
export async function getBlockingIssuesForPlan(planSlug: string): Promise<BlockingInfo> {
  const { sql } = getOrgPg();
  const rows = await sql<{ dst_ref: string; issue_id: string }[]>`
    SELECT l.dst_ref, l.src_ref AS issue_id
      FROM harness_shared.coord_links l
      JOIN harness_shared.engineer_issues i
        ON i.workspace_id = ${DEFAULT_COORD_WORKSPACE} AND i.issue_id = l.src_ref
     WHERE l.workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND l.rel = 'blocks'
       AND l.src_kind = 'issue'
       AND l.dst_kind = ${PLAN_ITEM_KIND}
       AND l.dst_ref LIKE ${planSlug + '#%'}
       AND i.state = 'open'
     ORDER BY l.src_ref`;
  const blockedItems = new Map<string, string[]>();
  const prefix = `${planSlug}#`;
  for (const r of rows) {
    if (!r.dst_ref.startsWith(prefix)) continue;
    const itemId = r.dst_ref.slice(prefix.length);
    const arr = blockedItems.get(itemId) ?? [];
    arr.push(r.issue_id);
    blockedItems.set(itemId, arr);
  }
  return { blockedItems };
}
