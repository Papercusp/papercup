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
import { featureRef, FEATURE_KIND } from '../issue-blocks-merge';

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
 */
export async function syncFeatureBlockEdges(
  harnessSlug: string,
  featureId: string,
  blockedBy: readonly string[],
): Promise<void> {
  const { sql } = getOrgPg();
  const dst = featureRef(harnessSlug, featureId);
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
