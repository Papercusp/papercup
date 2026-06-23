/**
 * Feature→feature blocking on the coord_links polymorphic edge — the work_items
 * unification of the legacy `harness_features_consolidated.blocked_by text[]`
 * column onto the shared substrate edge (D-027 / D-028, EI-1; the P-020 follow-on).
 *
 * A feature F blocked-by G is the edge:
 *   coord_links { workspace_id='default', rel='blocks', src_kind='feature',
 *                 src_ref=featureRef(harness, G)  // the BLOCKER
 *                 dst_kind='feature', dst_ref=featureRef(harness, F) }  // the BLOCKED
 * mirroring the issue→feature convention (issue-blocks-merge.ts: src `blocks` dst),
 * reusing su-a5a32's harness-qualified `featureRef` so 'F-001' can't collide across
 * harnesses. Distinct from ISSUE→feature blocking (src_kind='issue') — that's the
 * engineer-issues overlay; this is the feature-dependency the dispatch frontier reads.
 *
 * The dispatch frontier (orchestrator-loop.ts readFrontierFeatures) reads blocker
 * sets from HERE unconditionally — these edges are the SINGLE source of truth for
 * feature blocking (the legacy `blocked_by` column + hfc_blocked_by_gin_idx were
 * dropped in migration 155). The feature-import write-path (features.ts) keeps them
 * current via syncFeatureBlockEdges.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { featureRef, FEATURE_KIND, isQualifiedFeatureRef } from '../issue-blocks-merge';
import { syncWorkItemDepEdges, wouldCreateCycle } from './work-item-deps-store';
import { detectDependencyCycle } from '../feature-deps';

/**
 * For one harness, every feature with ≥1 feature→feature `blocks` edge, keyed by the
 * blocked feature_id → its blocker feature_ids (within-harness, prefix-stripped). The
 * coord_links_dst_idx supports this reverse ("what blocks me") lookup. Pure read.
 */
export async function getFeatureBlockers(harnessSlug: string): Promise<Map<string, string[]>> {
  const { sql } = getOrgPg();
  const prefix = `${harnessSlug}#`;
  const rows = await sql<{ dst_ref: string; src_ref: string }[]>`
    SELECT l.dst_ref, l.src_ref
      FROM harness_shared.coord_links l
     WHERE l.workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND l.rel = 'blocks'
       AND l.src_kind = ${FEATURE_KIND}
       AND l.dst_kind = ${FEATURE_KIND}
       AND l.dst_ref LIKE ${prefix + '%'}`;
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.dst_ref.startsWith(prefix) || !r.src_ref.startsWith(prefix)) continue;
    const blocked = r.dst_ref.slice(prefix.length);
    const blocker = r.src_ref.slice(prefix.length);
    const arr = out.get(blocked) ?? [];
    if (!arr.includes(blocker)) arr.push(blocker);
    out.set(blocked, arr);
  }
  return out;
}

/**
 * Sync ONE feature's coord_links feature→feature `blocks` edges to its current
 * `blocked_by` list (delete the feature's existing blocker edges, insert the new
 * set) — the dual-write the import/promote write-path calls when it sets
 * `blocked_by`, so edges stay current (not just backfilled). Idempotent.
 * Transactional so a read never sees a half-updated blocker set.
 *
 * ACYCLICITY (P-003, audit finding F4): this is the AUTHORITATIVE blocks-edge writer,
 * so the cycle guard lives HERE. A feature→feature `blocks` cycle silently DEADLOCKS the
 * dispatch frontier (every item in the cycle is forever non-ready — its blocker never
 * terminates), so a cycle-closing set is REJECTED (throws) rather than written. We load
 * the live blocks graph (getFeatureBlockers) and reuse `wouldCreateCycle` /
 * `detectDependencyCycle` — the SAME check work_item_deps enforces on its direct writes —
 * so coord_links and work_item_deps share one acyclicity invariant. Pass
 * `enforceAcyclicity:false` ONLY for a trusted backfill where the source was already
 * validated.
 */
export async function syncFeatureBlockEdges(
  harnessSlug: string,
  featureId: string,
  blockedBy: readonly string[],
  opts: { enforceAcyclicity?: boolean } = {},
): Promise<void> {
  const { sql } = getOrgPg();
  const dst = featureRef(harnessSlug, featureId);
  if (opts.enforceAcyclicity ?? true) {
    const current = await getFeatureBlockers(harnessSlug);
    if (wouldCreateCycle(current, featureId, blockedBy)) {
      throw new Error(
        `blocks: setting blocked_by for ${harnessSlug}#${featureId} to [${blockedBy.join(', ')}] would create a dependency cycle — rejected (a feature-dependency cycle permanently deadlocks the scheduler frontier)`,
      );
    }
  }
  const edges = featureBlockEdges(harnessSlug, featureId, blockedBy);
  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM harness_shared.coord_links
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND rel = 'blocks'
         AND dst_kind = ${FEATURE_KIND} AND dst_ref = ${dst}
         AND src_kind = ${FEATURE_KIND}`;
    for (const e of edges) {
      await tx`
        INSERT INTO harness_shared.coord_links
          (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel, created_by)
        VALUES (${e.workspace_id}, ${e.src_kind}, ${e.src_ref}, ${e.dst_kind}, ${e.dst_ref}, ${e.rel}, 'ei1-sync')
        ON CONFLICT (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel) DO NOTHING`;
    }
  });
  // P-003 transitional dual-write (work-item-deps-and-readiness-2026-06-22): mirror the same blocker
  // set into the dedicated work_item_deps table so it stays a COMPLETE mirror during the
  // coord_links -> work_item_deps cutover (the blockersOf() seam flips its read once backfill +
  // dual-write are in place). Best-effort + non-throwing: coord_links is still authoritative here and
  // acyclicity is disabled for the mirror (coord_links already accepted this set), so a mirror failure
  // can never break the authoritative write during the transition.
  try {
    await syncWorkItemDepEdges(harnessSlug, featureId, blockedBy, { enforceAcyclicity: false });
  } catch (err) {
    console.warn(
      `[feature-blockers-edges] work_item_deps mirror failed for ${harnessSlug}#${featureId}:`,
      err,
    );
  }
}

/** One feature→feature `blocks` edge row, ready to INSERT into coord_links. */
export interface FeatureBlockEdge {
  workspace_id: string;
  src_kind: string;
  src_ref: string;
  dst_kind: string;
  dst_ref: string;
  rel: string;
}

/**
 * Pure: expand a feature's `blocked_by` (blocker feature ids) into coord_links
 * edge rows. The shared core of the backfill migration + its equivalence test, so
 * the migration's SQL and the read can't silently diverge. Self-edges + empty refs
 * dropped (mirrors resolveBlockedByRefs).
 */
export function featureBlockEdges(
  harnessSlug: string,
  featureId: string,
  blockedBy: readonly string[],
): FeatureBlockEdge[] {
  const out: FeatureBlockEdge[] = [];
  for (const blocker of blockedBy) {
    const b = blocker.trim();
    if (!b || b === featureId) continue;
    out.push({
      workspace_id: DEFAULT_COORD_WORKSPACE,
      src_kind: FEATURE_KIND,
      src_ref: featureRef(harnessSlug, b),
      dst_kind: FEATURE_KIND,
      dst_ref: featureRef(harnessSlug, featureId),
      rel: 'blocks',
    });
  }
  return out;
}

/**
 * Acyclicity guard for the LINK tools (P-003, audit finding F4): would ADDING the single
 * feature→feature `blocks` edge "blocker blocks blocked" (within `harnessSlug`) close a cycle in
 * the LIVE graph? The link tools (issues:link / work_items:link) create one coord_links edge at a
 * time — bypassing syncFeatureBlockEdges' replace-semantics guard — so they call this to reject a
 * cycle-closing edge BEFORE the write. Loads the live graph (getFeatureBlockers), appends the new
 * blocker to the blocked feature's existing set, and reuses `wouldCreateCycle`. A self-edge is not
 * a cycle here (blocked === blocker is dropped by the writer / no-self-block invariant).
 */
export async function wouldFeatureBlockEdgeCreateCycle(
  harnessSlug: string,
  blockedFeatureId: string,
  blockerFeatureId: string,
): Promise<boolean> {
  if (blockedFeatureId === blockerFeatureId) return false;
  const current = await getFeatureBlockers(harnessSlug);
  const merged = Array.from(new Set([...(current.get(blockedFeatureId) ?? []), blockerFeatureId]));
  return wouldCreateCycle(current, blockedFeatureId, merged);
}

/**
 * Tool-facing acyclicity guard (P-003, audit finding F4): given the coord_links refs a `blocks`
 * edge would write — `srcRef` is the BLOCKER, `dstRef` the BLOCKED (the src-blocks-dst convention) —
 * reject it iff it closes a feature→feature cycle. A no-op (returns null) for any edge that is NOT
 * feature→feature within ONE harness (cross-kind / cross-harness edges can't form a feature-frontier
 * deadlock, so they're out of scope here). Returns a ready-to-surface error string when the edge
 * would cycle, else null. The link tools call this before writing a raw coord_links 'blocks' edge.
 */
export async function guardFeatureBlockEdgeAcyclic(
  srcRef: string,
  dstRef: string,
): Promise<string | null> {
  if (!isQualifiedFeatureRef(srcRef) || !isQualifiedFeatureRef(dstRef)) return null;
  const srcHash = srcRef.indexOf('#');
  const dstHash = dstRef.indexOf('#');
  const blockerHarness = srcRef.slice(0, srcHash);
  const blockedHarness = dstRef.slice(0, dstHash);
  if (blockerHarness !== blockedHarness) return null; // cross-harness — not a single-harness frontier cycle
  const blockerId = srcRef.slice(srcHash + 1);
  const blockedId = dstRef.slice(dstHash + 1);
  if (await wouldFeatureBlockEdgeCreateCycle(blockedHarness, blockedId, blockerId)) {
    return `'blocks' edge ${srcRef} → ${dstRef} would create a feature-dependency cycle — rejected (a cycle permanently deadlocks the scheduler frontier)`;
  }
  return null;
}

/**
 * Read-only RECONCILIATION (P-003, audit finding F4): detect any PRE-EXISTING cycle in the
 * LIVE feature→feature blocks graph for `harnessSlug`. The write-path guard (syncFeatureBlockEdges)
 * stops NEW cycles, but a cycle predating the guard (or one written through a path that bypassed it)
 * would silently deadlock the frontier forever — this surfaces it. Pure detection: loads the live
 * graph via getFeatureBlockers and runs `detectDependencyCycle`. Returns the cycle members (empty
 * when acyclic) and, when a cycle is found, logs a loud warning so a reconciliation sweep can act.
 */
export async function detectFeatureBlockGraphCycle(
  harnessSlug: string,
): Promise<{ hasCycle: boolean; cycleNodes: string[] }> {
  const current = await getFeatureBlockers(harnessSlug);
  const result = detectDependencyCycle(current);
  if (result.hasCycle) {
    console.warn(
      `[feature-blockers-edges] PRE-EXISTING feature-dependency CYCLE in harness '${harnessSlug}' among: ${result.cycleNodes.join(', ')} — these features are permanently non-ready (frontier deadlock); reconcile the blocks edges`,
    );
  }
  return result;
}
