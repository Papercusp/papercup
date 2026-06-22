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
import { featureRef, FEATURE_KIND } from '../issue-blocks-merge';
import { detectDependencyCycle } from '../feature-deps';

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
