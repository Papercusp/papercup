/**
 * plan-item assignment store — durable intent ("item P-005 is `builder-1`'s").
 *
 * Plan: plan-item-assignment-claim-liveness-2026-06-04 (Phase 0, D-001/D-002/D-006).
 *
 * Assignment is the FEDERATED, low-churn half of "who's doing this": a small
 * per-item record bound to a stable agent-NAME. An explicit release (released_ts)
 * clears it, so it survives sleep/interrupt and is the anchor a lapsed claim
 * returns to (D-004). The ONE exception (EI-2535): a stale-assignment reaper
 * (plan-items/stale-claims.ts) ALSO soft-releases an assignment whose holder is
 * dead past a long grace per a NAME-AWARE liveness rule — so a one-shot session-id
 * assignee whose session is permanently gone no longer strands the item forever
 * (an actively-running stable name re-adopts → stays alive → is never reaped). It
 * IS the substrate Claimable
 * `assignee` scalar for ObjectRef kind 'plan-item' (capabilities/types.ts) — the
 * same model a work_item's assignee uses (unify-work-items D-003); the leased CLAIM
 * (claims.ts) is the live grip on top.
 *
 * Item ids are the Stage-3 normalized `harness_plans.items[].id` (P-NNN); assigning
 * validates the item exists in the plan (a typo'd item never gets silently
 * assigned). Table: plan_item_assignments (migration 140); workspace+harness key the
 * SAME way harness_plans does (resolvePlanScope), so an assignment lines up with its
 * plan row. NO RLS (coord-family); org handle + workspace_id filter.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { ObjectRef, ClaimableStore } from '@papercusp/coordination/capabilities';
import { readPlanBySlug } from '../agent-tools/plans/source';

export const PLAN_ITEM_KIND = 'plan-item';

export interface PlanItemAssignment {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
  assigneeName: string | null;
  assignedByUser: string | null;
  assignedTs: string | null;
  releasedTs: string | null;
  strategy: string | null;
  note: string | null;
  updatedAt: string;
}

/** ObjectRef for a plan item — kind 'plan-item', ref '<harness>/<plan>/<item>'. */
export function planItemRef(harnessSlug: string, planSlug: string, itemId: string): ObjectRef {
  return { kind: PLAN_ITEM_KIND, ref: `${harnessSlug}/${planSlug}/${itemId}` };
}

/** Does this plan item exist (Stage-3 items, falling back to the parsed blob)? */
export async function planItemExists(
  harnessSlug: string,
  planSlug: string,
  itemId: string,
): Promise<boolean> {
  const read = await readPlanBySlug(planSlug, { harnessSlug });
  if (!read) return false;
  if (read.row.items.length > 0) return read.row.items.some((i) => i.id === itemId);
  return read.parsed.items.some((i) => i.id === itemId);
}

export interface AssignOpts {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
  assigneeName: string;
  assignedByUser: string;
  strategy?: string | null;
  note?: string | null;
  /** Skip the plan-item-existence check (federated/test inserts). Default false. */
  skipItemCheck?: boolean;
}

/**
 * Push-assign an item to an agent-name (intra-user, D-005). Upserts the per-item
 * record active (released_ts = NULL), (re)stamping assigned_ts. Reassigning to a
 * new name legitimately wins (LWW). Throws if the item doesn't exist in the plan.
 */
export async function assignItem(opts: AssignOpts): Promise<PlanItemAssignment> {
  if (!opts.skipItemCheck) {
    const exists = await planItemExists(opts.harnessSlug, opts.planSlug, opts.itemId);
    if (!exists) {
      throw new Error(
        `plan item ${opts.itemId} not found in ${opts.harnessSlug}/${opts.planSlug} ` +
          `(plan items are the Stage-3 P-NNN entries; check plans:items)`,
      );
    }
  }
  const { sql } = getOrgPg();
  const rows = await sql<AssignmentDbRow[]>`
    INSERT INTO harness_shared.plan_item_assignments
      (workspace_id, harness_slug, plan_slug, item_id, assignee_name, assigned_by_user,
       assigned_ts, released_ts, strategy, note, origin)
    VALUES
      (${opts.workspaceId}, ${opts.harnessSlug}, ${opts.planSlug}, ${opts.itemId},
       ${opts.assigneeName}, ${opts.assignedByUser}, now(), NULL,
       ${opts.strategy ?? null}, ${opts.note ?? null}, 'local')
    ON CONFLICT (workspace_id, harness_slug, plan_slug, item_id) DO UPDATE SET
      assignee_name    = EXCLUDED.assignee_name,
      assigned_by_user = EXCLUDED.assigned_by_user,
      assigned_ts      = now(),
      released_ts      = NULL,
      strategy         = EXCLUDED.strategy,
      note             = EXCLUDED.note,
      origin           = 'local'
    RETURNING workspace_id, harness_slug, plan_slug, item_id, assignee_name,
              assigned_by_user, assigned_ts, released_ts, strategy, note, updated_at
  `;
  return assignmentFromDb(rows[0]!);
}

/**
 * Release an assignment (soft, via released_ts) so it stops being active but the
 * row + history persist (LWW-friendly federation; a re-assign just nulls it again).
 * Returns the updated row, or null if there was no assignment.
 */
export async function unassignItem(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
  itemId: string,
): Promise<PlanItemAssignment | null> {
  const { sql } = getOrgPg();
  const rows = await sql<AssignmentDbRow[]>`
    UPDATE harness_shared.plan_item_assignments
       SET released_ts = now(), origin = 'local'
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND plan_slug = ${planSlug} AND item_id = ${itemId}
       AND released_ts IS NULL
    RETURNING workspace_id, harness_slug, plan_slug, item_id, assignee_name,
              assigned_by_user, assigned_ts, released_ts, strategy, note, updated_at
  `;
  return rows[0] ? assignmentFromDb(rows[0]) : null;
}

/** The ACTIVE assignment for an item (released_ts IS NULL), or null. */
export async function getAssignment(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
  itemId: string,
): Promise<PlanItemAssignment | null> {
  const { sql } = getOrgPg();
  const rows = await sql<AssignmentDbRow[]>`
    SELECT workspace_id, harness_slug, plan_slug, item_id, assignee_name,
           assigned_by_user, assigned_ts, released_ts, strategy, note, updated_at
      FROM harness_shared.plan_item_assignments
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND plan_slug = ${planSlug} AND item_id = ${itemId} AND released_ts IS NULL
  `;
  return rows[0] ? assignmentFromDb(rows[0]) : null;
}

/** Active assignments to an agent-name across all plans in a workspace (my-items). */
export async function listAssignmentsForName(
  workspaceId: string,
  assigneeName: string,
): Promise<PlanItemAssignment[]> {
  const { sql } = getOrgPg();
  const rows = await sql<AssignmentDbRow[]>`
    SELECT workspace_id, harness_slug, plan_slug, item_id, assignee_name,
           assigned_by_user, assigned_ts, released_ts, strategy, note, updated_at
      FROM harness_shared.plan_item_assignments
     WHERE workspace_id = ${workspaceId} AND assignee_name = ${assigneeName} AND released_ts IS NULL
     ORDER BY harness_slug, plan_slug, item_id
  `;
  return rows.map(assignmentFromDb);
}

/** All active assignments for a plan (the assignment side of the merged view). */
export async function listAssignmentsForPlan(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
): Promise<PlanItemAssignment[]> {
  const { sql } = getOrgPg();
  const rows = await sql<AssignmentDbRow[]>`
    SELECT workspace_id, harness_slug, plan_slug, item_id, assignee_name,
           assigned_by_user, assigned_ts, released_ts, strategy, note, updated_at
      FROM harness_shared.plan_item_assignments
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND plan_slug = ${planSlug} AND released_ts IS NULL
     ORDER BY item_id
  `;
  return rows.map(assignmentFromDb);
}

// ── Claimable-capability conformance ────────────────────────────────────────────
// Plan-item assignment IS the substrate Claimable `assignee` scalar (D-002). This
// thin adapter lets tools/UI treat a plan item as any other Claimable object
// (ObjectRef kind 'plan-item'), keeping it on the SAME model as work_item's
// assignee (unify-work-items D-003). The richer assignItem() (assigned_by_user,
// strategy, validation) is the primary surface; this is the uniform view.
export class PlanItemClaimableStore implements ClaimableStore {
  constructor(private readonly workspaceId: string) {}
  async claim(object: ObjectRef, assignee: string): Promise<void> {
    const { harnessSlug, planSlug, itemId } = parsePlanItemRef(object);
    await assignItem({
      workspaceId: this.workspaceId,
      harnessSlug,
      planSlug,
      itemId,
      assigneeName: assignee,
      assignedByUser: assignee,
      skipItemCheck: true,
    });
  }
  async release(object: ObjectRef): Promise<void> {
    const { harnessSlug, planSlug, itemId } = parsePlanItemRef(object);
    await unassignItem(this.workspaceId, harnessSlug, planSlug, itemId);
  }
  async getAssignee(object: ObjectRef): Promise<string | null> {
    const { harnessSlug, planSlug, itemId } = parsePlanItemRef(object);
    const a = await getAssignment(this.workspaceId, harnessSlug, planSlug, itemId);
    return a?.assigneeName ?? null;
  }
}

function parsePlanItemRef(object: ObjectRef): { harnessSlug: string; planSlug: string; itemId: string } {
  const parts = object.ref.split('/');
  if (object.kind !== PLAN_ITEM_KIND || parts.length !== 3 || parts.some((p) => !p)) {
    throw new Error(`not a plan-item ObjectRef: ${object.kind}:${object.ref}`);
  }
  return { harnessSlug: parts[0]!, planSlug: parts[1]!, itemId: parts[2]! };
}

interface AssignmentDbRow {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  item_id: string;
  assignee_name: string | null;
  assigned_by_user: string | null;
  assigned_ts: string | null;
  released_ts: string | null;
  strategy: string | null;
  note: string | null;
  updated_at: string;
}
function assignmentFromDb(r: AssignmentDbRow): PlanItemAssignment {
  return {
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    planSlug: r.plan_slug,
    itemId: r.item_id,
    assigneeName: r.assignee_name,
    assignedByUser: r.assigned_by_user,
    assignedTs: r.assigned_ts,
    releasedTs: r.released_ts,
    strategy: r.strategy,
    note: r.note,
    updatedAt: r.updated_at,
  };
}
