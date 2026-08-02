/**
 * work-item-deps-store — read/write the dedicated `work_item_deps` table
 * (work-item-deps-and-readiness-2026-06-22 P-002/P-003) + the acyclicity guard (P-008).
 *
 * This is the NEW backend for the blockersOf() seam (work-item-blocking.ts), replacing
 * coord_links rel='blocks'. Same feature→feature shape as the coord_links reader
 * (feature-blockers-edges.ts) so the seam swap is transparent, but on a dedicated, indexed,
 * single-purpose table. Acyclicity is enforced HERE on write (a CHECK can't see the transitive
 * graph), reusing `detectDependencyCycle`. FK to the unified work_items lands with P-009.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { featureRef, FEATURE_KIND, isQualifiedFeatureRef } from '../issue-blocks-merge';
import { detectDependencyCycle } from '../feature-deps';

/** The polymorphic endpoints accepted by work_item_deps (issue/feature today). */
export interface WorkItemDepEndpoint {
  kind: string;
  ref: string;
}

export interface WorkItemBlockingEdge {
  blocked_kind: string;
  blocked_ref: string;
  blocker_kind: string;
  blocker_ref: string;
  dep_type: 'blocks';
}

/** The issue-family endpoint kind, the counterpart of FEATURE_KIND for this table. */
const ISSUE_ENDPOINT_KIND = 'issue';

/**
 * P-005 / D-009 — the kind↔ref-FORM invariant, enforced at the ONE write seam.
 *
 * `work_item_deps` endpoints use a ref form determined by their family, and this is
 * deliberate, not an inconsistency to normalize away (D-009, after measuring all 94 rows /
 * 188 endpoint-sides: zero violations, the form is a pure function of the `*_kind` column):
 *
 *   - `feature` → harness-QUALIFIED `<harness>#<feature_id>`, because a feature's identity is
 *     (harness_slug, feature_id); a bare `F-NNN` would mis-attribute a block to the same id in
 *     another project. Gated by `work_item_is_blocked()` + the `work_item_blocked` sidecar.
 *   - `issue`   → BARE `EI-NNN` / `WI-NNN` (issues:link). Gated by `depsBlockedExclusionSql`,
 *     which keys on the bare `feature_id` because the `wir_*` sidecar triggers do not track
 *     issues. Teaching either predicate to match BOTH forms over-gates the feature family —
 *     that is D-007's retraction, and it is why the two forms must stay distinct.
 *
 * WHY A GUARD RATHER THAN A MIGRATION (the P-005 re-scope). Nothing enforced this: both link
 * doors funnel here, but only `linkWorkItem` checked a ref form, only on the `dst`, and only in
 * the feature direction — `linkIssue` mirrored straight through with no check at all. That is
 * the same shape as D-007 itself: a rule applied at one door instead of at the shared seam, so
 * the unchecked door drifts. A form-mismatched edge is not cosmetic — it is INVISIBLE TO BOTH
 * FLOORS (the issue floor looks for the bare ref and misses; the feature floor matches only the
 * qualified form), i.e. a silently inert dependency that looks recorded and gates nothing. A
 * one-time migration could not prevent it, because the next bad write recreates it.
 *
 * ⚠ WHAT THIS DELIBERATELY DOES **NOT** CATCH — do not read it as more coverage than it has.
 * This validates the ref's FORM against the declared `kind`. It cannot validate that the endpoint
 * RESOLVES to a row of that kind, because that needs a database read and this function is pure
 * (its purity is what lets the invariant be tested exhaustively and applied on every write path
 * without an await). A row can therefore satisfy this guard and still be inert: 3 such rows exist
 * live — `offsite-planner-demo#WI-247/248/249` carry `blocked_kind='feature'` with a properly
 * QUALIFIED ref, but the rows they point at are `item_kind='task'` (issue-family), so the issue
 * floor never matches them (it keys on the bare id) and the feature floor never evaluates them
 * (the sidecar triggers are feature-only). That kind↔TARGET-FAMILY check is a separate, DB-backed
 * guard, tracked separately — this one is its necessary but not sufficient half.
 *
 * Throws rather than returning null: `null` already means "self-edge, skip", and overloading it
 * with "malformed, dropped" would make a caller bug SILENT — the exact failure mode this guards.
 * Both callers already restrict to issue|feature, so any other kind is left alone rather than
 * rejected, keeping this a validator of the ratified convention and not a new kind whitelist.
 */
export function assertDepEndpointRefForm(endpoint: WorkItemDepEndpoint, role: 'blocked' | 'blocker'): void {
  const qualified = isQualifiedFeatureRef(endpoint.ref);
  if (endpoint.kind === FEATURE_KIND && !qualified) {
    throw new Error(
      `work_item_deps ${role} endpoint kind='${FEATURE_KIND}' requires a harness-qualified ref ` +
        `'<harness>#<feature_id>', got '${endpoint.ref}'. A bare ref here is invisible to BOTH ` +
        `blocking floors, so the edge would be silently inert (D-009 / D-007).`,
    );
  }
  if (endpoint.kind === ISSUE_ENDPOINT_KIND && qualified) {
    throw new Error(
      `work_item_deps ${role} endpoint kind='${ISSUE_ENDPOINT_KIND}' requires a BARE ref ` +
        `(e.g. 'EI-123'), got the harness-qualified '${endpoint.ref}'. The issue floor keys on the ` +
        `bare feature_id, so a qualified ref here is silently inert (D-009 / D-007).`,
    );
  }
}

/** Pure coord_links (blocker → blocked) to work_item_deps (blocked → blocker) mapping. */
export function workItemBlockingEdge(
  blocker: WorkItemDepEndpoint,
  blocked: WorkItemDepEndpoint,
): WorkItemBlockingEdge | null {
  if (blocker.kind === blocked.kind && blocker.ref === blocked.ref) return null;
  // AFTER the self-edge check: a self-edge is a legitimate no-op the callers rely on, so it must
  // stay a quiet `null` even if both its endpoints are malformed.
  assertDepEndpointRefForm(blocked, 'blocked');
  assertDepEndpointRefForm(blocker, 'blocker');
  return {
    blocked_kind: blocked.kind,
    blocked_ref: blocked.ref,
    blocker_kind: blocker.kind,
    blocker_ref: blocker.ref,
    dep_type: 'blocks',
  };
}

/**
 * Mirror one coord_links `blocks` edge into the scheduler's readiness store.
 * coord_links uses blocker → blocked orientation; work_item_deps stores the
 * same edge as blocked → blocker. Keeping this conversion here gives every
 * work-item link writer one durable mirror primitive.
 */
export async function mirrorWorkItemBlockingEdge(
  blocker: WorkItemDepEndpoint,
  blocked: WorkItemDepEndpoint,
  opts: { createdBy?: string } = {},
): Promise<void> {
  const edge = workItemBlockingEdge(blocker, blocked);
  if (!edge) return;
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, created_by)
    VALUES
      (${DEFAULT_COORD_WORKSPACE}, ${edge.blocked_kind}, ${edge.blocked_ref}, ${edge.blocker_kind}, ${edge.blocker_ref}, ${edge.dep_type}, ${opts.createdBy ?? null})
    ON CONFLICT (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    DO NOTHING`;
}

/** Remove the scheduler-readiness mirror for one coord_links `blocks` edge. */
export async function removeMirroredWorkItemBlockingEdge(
  blocker: WorkItemDepEndpoint,
  blocked: WorkItemDepEndpoint,
): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    DELETE FROM harness_shared.work_item_deps
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND blocked_kind = ${blocked.kind}
       AND blocked_ref = ${blocked.ref}
       AND blocker_kind = ${blocker.kind}
       AND blocker_ref = ${blocker.ref}
       AND dep_type = 'blocks'`;
}

/** blocked feature_id → blocker feature_ids (within `harnessSlug`, prefix-stripped). Pure read. */
export async function getWorkItemDepBlockers(harnessSlug: string): Promise<Map<string, string[]>> {
  const { sql } = getOrgPg();
  const prefix = `${harnessSlug}#`;
  const rows = await sql<{ blocked_ref: string; blocker_ref: string }[]>`
    SELECT blocked_ref, blocker_ref
      FROM harness_shared.work_item_deps
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND dep_type = 'blocks'
       AND blocked_kind = ${FEATURE_KIND}
       AND blocker_kind = ${FEATURE_KIND}
       AND blocked_ref LIKE ${prefix + '%'}`;
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.blocked_ref.startsWith(prefix) || !r.blocker_ref.startsWith(prefix)) continue;
    const blocked = r.blocked_ref.slice(prefix.length);
    const blocker = r.blocker_ref.slice(prefix.length);
    const arr = out.get(blocked) ?? [];
    if (!arr.includes(blocker)) arr.push(blocker);
    out.set(blocked, arr);
  }
  return out;
}

/**
 * Acyclicity guard (P-008): would REPLACING `blocked`'s blocker set with `newBlockers` create a
 * dependency cycle? Pure (reuses detectDependencyCycle). Replace-semantics matches the writer
 * (delete + insert the blocked item's edges); self-edges are dropped (the no-self-block invariant).
 */
export function wouldCreateCycle(
  current: ReadonlyMap<string, readonly string[]>,
  blocked: string,
  newBlockers: readonly string[],
): boolean {
  const edges = new Map<string, string[]>();
  for (const [k, v] of current) if (k !== blocked) edges.set(k, [...v]);
  edges.set(blocked, Array.from(new Set(newBlockers.filter((b) => b !== blocked))));
  return detectDependencyCycle(edges).hasCycle;
}

/**
 * Set ONE feature's `blocks` edges in work_item_deps to exactly `blockedBy` (delete + insert),
 * rejecting any set that would introduce a cycle (P-008). Transactional + idempotent. Mirrors
 * syncFeatureBlockEdges (coord_links) so the dual-write / cutover (P-003) is a 1:1 swap.
 */
export async function syncWorkItemDepEdges(
  harnessSlug: string,
  featureId: string,
  blockedBy: readonly string[],
  opts: { enforceAcyclicity?: boolean } = {},
): Promise<void> {
  // Acyclicity is enforced for DIRECT writes (default). The transitional dual-write from
  // syncFeatureBlockEdges passes enforceAcyclicity:false — coord_links already accepted the set,
  // so the mirror must not throw (it would break the authoritative write during the cutover).
  if (opts.enforceAcyclicity ?? true) {
    const current = await getWorkItemDepBlockers(harnessSlug);
    if (wouldCreateCycle(current, featureId, blockedBy)) {
      throw new Error(
        `work_item_deps: setting blocked_by for ${harnessSlug}#${featureId} would create a dependency cycle`,
      );
    }
  }
  const { sql } = getOrgPg();
  const blockedRef = featureRef(harnessSlug, featureId);
  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM harness_shared.work_item_deps
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND dep_type = 'blocks'
         AND blocked_kind = ${FEATURE_KIND} AND blocked_ref = ${blockedRef}
         AND blocker_kind = ${FEATURE_KIND}`;
    for (const b of blockedBy) {
      const blockerRef = featureRef(harnessSlug, b);
      if (blockerRef === blockedRef) continue; // no self-block
      await tx`
        INSERT INTO harness_shared.work_item_deps
          (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
        VALUES (${DEFAULT_COORD_WORKSPACE}, ${FEATURE_KIND}, ${blockedRef}, ${FEATURE_KIND}, ${blockerRef}, 'blocks')
        ON CONFLICT DO NOTHING`;
    }
  });
}
