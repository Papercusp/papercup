/**
 * dependency-graph-edges.ts — the EDGE half of the Work-tab dependency graph pane.
 *
 * Plan: dependency-health-pane-2026-08-02 (P-003, the data seam).
 *
 * ── WHY THIS IS EDGES ONLY ──────────────────────────────────────────────────────────────
 * The owner's ask was a pane that "shows all the same data as our work items list view but in
 * graph form". Taken literally, that means the graph's NODES are the list's rows — so this
 * module deliberately does NOT re-query work items. The pane reuses the existing
 * `workItems.byHarness` sync query for nodes and adds only the edges the list has no column
 * for. Two things follow, and both are the point:
 *
 *   • ONE node corpus. A second node query would drift from the list's (different limit,
 *     different filters, different projection) and the two panes would disagree about what
 *     exists — the precise failure the "same data" phrasing rules out.
 *   • The same trick DetailPanel already uses: it reads the selected row out of the
 *     already-loaded `workItems.byHarness` result rather than firing its own fetch, because
 *     a second multi-MB fetch starves the WebView2 ~6-connection-per-host cap and shows up
 *     as a pane stuck on "Loading".
 *
 * ── ENDPOINT RESOLUTION IS FAMILY-AWARE, AND THAT IS THE WHOLE SUBTLETY ─────────────────
 * `work_item_deps` stores each endpoint as a `*_ref` whose FORM depends on the family of the
 * row it points at (D-009 rule 1, and the invariant registry's INV-01):
 *
 *     feature family → '<harness>#<feature_id>'   (harness-qualified)
 *     issue   family → '<feature_id>'             (bare, unqualified)
 *
 * so a join that matches only one form silently drops every edge of the other family. That is
 * not hypothetical: it is exactly the D-017 defect — six live edges that were form-valid,
 * mirrored and acyclic, and gated nothing, because the writer emitted the feature convention
 * while the issue floor matched bare. The join below therefore dispatches on the TARGET ROW'S
 * `item_kind`, mirroring `work_item_is_blocked` (migration 719) rather than re-deciding the
 * convention here.
 *
 * ⚠ `d.workspace_id` is pinned to the COORDINATION workspace ('default'), NOT the caller's
 * workspace. Every edge row lives there by design whatever workspace its items live in
 * (migration 719 says so explicitly and warns against "fixing" it: scoping the edge lookup to
 * the item workspace "would match zero rows and disable blocking entirely"). The ITEM joins
 * are scoped to the caller's workspace; the EDGE table is not. Those are different axes.
 *
 * ── DANGLING EDGES ARE RETURNED, NOT FILTERED ──────────────────────────────────────────
 * The blocker side is a LEFT JOIN on purpose. An edge whose blocker resolves to no row in this
 * harness is a FINDING (INV-13, the stale class) and Phase 3's integrity mode has to render
 * it; an INNER JOIN would make exactly the broken edges invisible in the pane built to show
 * broken edges. `blockerId === null` is how the UI spots one.
 */
import type { Sql } from 'postgres';

/** The coordination workspace `work_item_deps` is keyed in. NOT a tenant knob — see header. */
const COORD_WORKSPACE = 'default';

/** Families, as the ENGINE decides them: by the VALUE of item_kind, never by a family name. */
const ISSUE_KINDS = ['bug', 'change', 'task'] as const;

export interface DependencyGraphEdge {
  /** feature_id of the BLOCKED item (the dependant). Always resolves — it is an inner join. */
  blockedId: string;
  /** feature_id of the BLOCKER, or null when the ref resolves to no row here (INV-13). */
  blockerId: string | null;
  /** The blocker's raw ref as stored — the only handle a dangling edge has. */
  blockerRef: string;
  blockedKind: string;
  blockerKind: string | null;
  /** Blocker lifecycle status — lets the UI grey out an edge whose blocker is already terminal. */
  blockerStatus: string | null;
}

/** Bound the payload. The pane renders a filtered subgraph (D-003), never the whole corpus. */
export const DEP_EDGES_MAX_LIMIT = 5000;

/**
 * Every `blocks` edge with at least its BLOCKED endpoint resolving into (workspace, harness).
 *
 * @param sql org admin postgres handle.
 * @param opts workspaceId + harnessSlug scope the ITEM joins (never the edge table); `limit` is
 *   CLAMPED, never rejected — a client asking for more than the cap must degrade gracefully
 *   rather than error the panel (the same reason `workItems.byHarness` clamps instead of
 *   `.max()`-ing its schema: a newer client against an older resolver would otherwise turn a
 *   version skew into a panel-breaking failure).
 */
export async function resolveDependencyGraphEdges(
  sql: Sql,
  opts: { workspaceId: string; harnessSlug: string; limit?: number },
): Promise<DependencyGraphEdge[]> {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEP_EDGES_MAX_LIMIT)), DEP_EDGES_MAX_LIMIT);
  const rows = await sql<
    Array<{
      blocked_id: string;
      blocker_id: string | null;
      blocker_ref: string;
      blocked_kind: string;
      blocker_kind: string | null;
      blocker_status: string | null;
    }>
  >`
    SELECT bd.feature_id  AS blocked_id,
           bk.feature_id  AS blocker_id,
           d.blocker_ref  AS blocker_ref,
           bd.item_kind   AS blocked_kind,
           bk.item_kind   AS blocker_kind,
           bk.status      AS blocker_status
      FROM harness_shared.work_item_deps d
      -- BLOCKED side: inner. An edge whose dependant is not in this harness is not ours.
      JOIN harness_shared.work_items bd
        ON bd.workspace_id = ${opts.workspaceId}
       AND bd.harness_slug = ${opts.harnessSlug}
       AND (
         (bd.item_kind = ANY (${ISSUE_KINDS as unknown as string[]}) AND d.blocked_ref = bd.feature_id)
         OR
         (bd.item_kind <> ALL (${ISSUE_KINDS as unknown as string[]})
           AND d.blocked_ref = bd.harness_slug || '#' || bd.feature_id)
       )
      -- BLOCKER side: LEFT. A blocker resolving to nothing is a dangling edge — a finding the
      -- integrity mode must render, not a row to drop (see header).
      LEFT JOIN harness_shared.work_items bk
        ON bk.workspace_id = ${opts.workspaceId}
       AND bk.harness_slug = ${opts.harnessSlug}
       AND (
         (bk.item_kind = ANY (${ISSUE_KINDS as unknown as string[]}) AND d.blocker_ref = bk.feature_id)
         OR
         (bk.item_kind <> ALL (${ISSUE_KINDS as unknown as string[]})
           AND d.blocker_ref = bk.harness_slug || '#' || bk.feature_id)
       )
     WHERE d.dep_type = 'blocks'
       AND d.workspace_id = ${COORD_WORKSPACE}
     ORDER BY bd.feature_id, d.blocker_ref
     LIMIT ${limit}`;

  return rows.map((r) => ({
    blockedId: r.blocked_id,
    blockerId: r.blocker_id,
    blockerRef: r.blocker_ref,
    blockedKind: r.blocked_kind,
    blockerKind: r.blocker_kind,
    blockerStatus: r.blocker_status,
  }));
}
