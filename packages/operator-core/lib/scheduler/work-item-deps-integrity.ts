/**
 * work-item-deps-integrity.ts — endpoint-integrity detector for `work_item_deps`
 * (work-item-dependency-edges-2026-08-02, EI-19325959789634791 / D-017 step 2).
 *
 * D-017's defect: a `work_item_deps` endpoint carries a `*_kind` alongside a ref, and
 * NOTHING checked that the endpoint actually RESOLVES to a row of the declared kind. An
 * edge could be perfectly FORM-valid (D-009 rule 1: feature = harness-qualified, issue =
 * bare) and still gate nothing, because the issue floor matches `d.blocked_ref =
 * wi.feature_id` — BARE — while the writer emitted the feature convention. Measured live
 * 2026-08-02: 6 such rows in papercusp, 3 on genuinely-open items with non-terminal
 * blockers, every one advertised claimable while blocked.
 *
 * The write seam was fixed (`resolveDepEndpoint` now dispatches on the target row's real
 * family), which makes the mismatch INEXPRESSIBLE going forward. This module is the other
 * half: a CONTINUOUS detector, because the one-off audit that found those 6 rows rots the
 * moment it stops being re-run — and rows also arrive from backfills, imports and other
 * harnesses that a single audit never covered.
 *
 * ── Why this is NOT part of reconcileReadiness ──────────────────────────────────────────
 * Deliberate, and load-bearing. `reconcileReadiness` (readiness-reconcile.ts) is:
 *   • FEATURE-ONLY — its oracle CTE filters `item_kind <> ALL ('bug','change','task')`,
 *     i.e. it structurally cannot see the ISSUE-family rows this defect lives in; and
 *   • a different INVARIANT — sidecar (`work_item_blocked`) vs oracle (`work_item_is_blocked`)
 *     drift, over a different table.
 * Folding this in would hide an issue-family detector inside a feature-only function. The
 * seam that IS reused is the ROUTINE: `readiness-drift-monitor` already runs hourly and
 * already separates pure-detect from repair, so this detector rides that same tick.
 *
 * ── Resolution must match the WRITER, which matches the FLOOR ───────────────────────────
 * Family is resolved against `harness_shared.engineer_issues` on the BARE id, with NO
 * harness qualifier and NO workspace scope — identical to `resolveDepEndpoint` and to the
 * issue floor's blocker leg (`bi.issue_id = d.blocker_ref`). Asking a different relation
 * than the floor would just relocate the bug: a first attempt at the D-017 fix resolved
 * family from `work_items.item_kind` and silently returned 'feature' for everything.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';

/** The issue-family endpoint kind — the counterpart of FEATURE_KIND for this table. */
const ISSUE_ENDPOINT_KIND = 'issue';
const FEATURE_ENDPOINT_KIND = 'feature';

/** Which side of the edge an endpoint sits on. */
export type DepEndpointSide = 'blocked' | 'blocker';

/** One offending endpoint, identified precisely enough to repair it. */
export interface DepEndpointDefect {
  /** work_item_deps.id — the row to repair. */
  edge_id: string;
  workspace_id: string;
  side: DepEndpointSide;
  /** The `*_kind` the row DECLARES. */
  declared_kind: string;
  /** The `*_ref` as stored (qualified or bare, exactly as written). */
  ref: string;
  /**
   * The kind the endpoint SHOULD carry, derived from the row it actually resolves to.
   * Null for a dangling endpoint — it resolves to nothing, so there is no right answer.
   */
  expected_kind: string | null;
}

export interface WorkItemDepsIntegrityResult {
  /** mismatched.length + dangling.length — total endpoint-integrity violations. */
  defects: number;
  /**
   * Endpoints whose declared kind (or ref FORM) disagrees with the family of the row they
   * resolve to — the D-017 shape. These are INERT edges: form-valid, mirrored, acyclic,
   * counted by every row-shape check, and invisible to the floor that must honour them.
   */
  mismatched: DepEndpointDefect[];
  /**
   * Endpoints resolving to NO row in either family. Reported SEPARATELY from `mismatched`
   * because they are not the same defect and must not be repaired the same way: the writer
   * deliberately tolerates an absent blocker (`resolveDepEndpoint` falls back to the feature
   * form so an edge naming a not-yet-created item stays writable). A dangling endpoint is
   * therefore a data-hygiene finding — a stale ref to a deleted/never-created item — not
   * proof of a writer bug. Repair by deleting the edge, never by rewriting its kind.
   */
  dangling: DepEndpointDefect[];
}

/**
 * Detect `work_item_deps` endpoints whose declared kind disagrees with the target row's
 * real family, plus endpoints that resolve to nothing, in ONE round-trip.
 *
 * Pure detector — it reports, it never repairs. Same seam as `reconcileReadiness`: the
 * routine action owns repair so detection stays independently testable and safe to run
 * anywhere.
 *
 * @param sql org admin postgres handle; defaults to `getOrgPg().sql`. Pass an explicit
 *   handle in tests (the integration test points it at a testcontainer DB).
 */
export async function reconcileWorkItemDepEndpoints(
  sql: Sql = getOrgPg().sql,
): Promise<WorkItemDepsIntegrityResult> {
  const rows = await sql<
    Array<{
      defect: 'mismatched' | 'dangling';
      edge_id: string;
      workspace_id: string;
      side: DepEndpointSide;
      declared_kind: string;
      ref: string;
      expected_kind: string | null;
    }>
  >`
    WITH endpoints AS (
      -- Both sides, flattened. The blocked side is where D-017's live rows were wrong, but
      -- the blocker side carries the identical invariant and is checked the same way.
      SELECT id, workspace_id, 'blocked'::text AS side, blocked_kind AS declared_kind, blocked_ref AS ref
        FROM harness_shared.work_item_deps
       WHERE dep_type = 'blocks'
      UNION ALL
      SELECT id, workspace_id, 'blocker'::text, blocker_kind, blocker_ref
        FROM harness_shared.work_item_deps
       WHERE dep_type = 'blocks'
    ),
    split AS (
      -- D-009 rule 1: a feature ref is '<harness>#<id>', an issue ref is bare. Split on the
      -- LAST '#' so a harness slug containing one cannot truncate the id.
      SELECT e.*,
             CASE WHEN strpos(e.ref, '#') > 0
                  THEN substring(e.ref from length(e.ref) - strpos(reverse(e.ref), '#') + 2)
                  ELSE e.ref END AS bare_id,
             CASE WHEN strpos(e.ref, '#') > 0
                  THEN substring(e.ref from 1 for length(e.ref) - strpos(reverse(e.ref), '#'))
                  ELSE NULL END AS ref_harness
        FROM endpoints e
    ),
    resolved AS (
      SELECT s.*,
             -- The FLOOR's own relation, matched the FLOOR's own way: bare id, no harness
             -- qualifier, no workspace scope. Must not drift from resolveDepEndpoint.
             EXISTS (
               SELECT 1 FROM harness_shared.engineer_issues i WHERE i.issue_id = s.bare_id
             ) AS is_issue,
             EXISTS (
               SELECT 1 FROM harness_shared.work_items f
                WHERE f.item_kind <> ALL (ARRAY['bug','change','task'])
                  AND f.feature_id = s.bare_id
                  AND (s.ref_harness IS NULL OR f.harness_slug = s.ref_harness)
             ) AS is_feature
        FROM split s
    ),
    judged AS (
      SELECT r.*,
             CASE WHEN r.is_issue THEN ${ISSUE_ENDPOINT_KIND}
                  WHEN r.is_feature THEN ${FEATURE_ENDPOINT_KIND}
                  ELSE NULL END AS expected_kind,
             -- The ref FORM is half the invariant: an issue endpoint must be BARE and a
             -- feature endpoint QUALIFIED. A row can declare the right kind in the wrong
             -- form and still be invisible to the floor, so both are checked.
             CASE WHEN r.is_issue THEN (strpos(r.ref, '#') = 0)
                  WHEN r.is_feature THEN (strpos(r.ref, '#') > 0)
                  ELSE TRUE END AS form_ok
        FROM resolved r
    )
    SELECT
      CASE WHEN expected_kind IS NULL THEN 'dangling' ELSE 'mismatched' END AS defect,
      id::text AS edge_id, workspace_id, side, declared_kind, ref, expected_kind
      FROM judged
     WHERE expected_kind IS NULL
        OR declared_kind IS DISTINCT FROM expected_kind
        OR NOT form_ok
     ORDER BY defect, workspace_id, ref, side
  `;

  const mismatched: DepEndpointDefect[] = [];
  const dangling: DepEndpointDefect[] = [];
  for (const r of rows) {
    const defect: DepEndpointDefect = {
      edge_id: r.edge_id,
      workspace_id: r.workspace_id,
      side: r.side,
      declared_kind: r.declared_kind,
      ref: r.ref,
      expected_kind: r.expected_kind,
    };
    if (r.defect === 'mismatched') mismatched.push(defect);
    else dangling.push(defect);
  }

  return { defects: mismatched.length + dangling.length, mismatched, dangling };
}
