/**
 * Rationale projection service — the operator wiring of `@papercusp/projection-index`
 * (docs-and-memory-as-projections-2026-06-05 D-003, P0 keystone).
 *
 * Composes the pure `rationaleProjector` with the PG-backed `PgRationaleStore` into
 * one `ProjectionIndex`, anchored on `globalThis` so the tsx runtime and a vitest
 * module graph share ONE instance (the same pattern the reaction registry uses).
 * Exposes the maintenance verbs the event rules fire and the query the read tool
 * serves:
 *   - reprojectPlan / reprojectWorkItem — incremental, event-driven (re-derive one
 *     source from its store, diff against its prior contributions). Idempotent.
 *   - reprojectInsights / backfillAll  — bulk (re)build.
 *   - queryTopic                       — the read path (`rationale:feed`).
 *
 * Re-projecting a source that no longer exists, lost all its tags, or lost all its
 * decisions correctly REMOVES its stale contributions — the projector returns `[]`
 * and the index diffs them away. Maintenance never needs to compute what changed.
 */

import {
  ProjectionIndex,
  type IndexedEntry,
  type QueryOptions,
} from '@papercusp/projection-index';
import { rationaleProjector } from './projector';
import { PgRationaleStore } from './pg-store';
import {
  gatherPlanSource,
  gatherAllPlanSources,
  gatherWorkItemSource,
  gatherTaggedWorkItemSources,
  gatherAllInsightSources,
} from './gather';
import { sourceIdOf, type RationaleEntry, type RationaleSource } from './types';

export type RationaleIndex = ProjectionIndex<RationaleSource, RationaleEntry>;

const GLOBAL_KEY = '__papercuspRationaleIndex__';

/** The process-wide projection index (PG-backed). Lazily built, globally anchored. */
export function getRationaleIndex(): RationaleIndex {
  const g = globalThis as Record<string, unknown>;
  let idx = g[GLOBAL_KEY] as RationaleIndex | undefined;
  if (!idx) {
    idx = new ProjectionIndex<RationaleSource, RationaleEntry>({
      projector: rationaleProjector,
      store: new PgRationaleStore(),
    });
    g[GLOBAL_KEY] = idx;
  }
  return idx;
}

/** Test seam: inject an in-memory-backed index (set null to reset to PG). */
export function __setRationaleIndexForTests(idx: RationaleIndex | null): void {
  const g = globalThis as Record<string, unknown>;
  if (idx) g[GLOBAL_KEY] = idx;
  else delete g[GLOBAL_KEY];
}

// --- incremental maintenance (fired by event rules) ---

/** Re-project one plan's decisions into the index (or remove them if it's gone). */
export async function reprojectPlan(slug: string, harness?: string): Promise<void> {
  const src = await gatherPlanSource(slug, harness);
  if (src) await getRationaleIndex().index(sourceIdOf(src), src);
  else await getRationaleIndex().remove(`plan:${slug}`);
}

/** Re-project one work-item into the index (or remove it if it's gone). */
export async function reprojectWorkItem(id: string, harness?: string): Promise<void> {
  const src = await gatherWorkItemSource(id, harness);
  if (src) await getRationaleIndex().index(sourceIdOf(src), src);
  else await getRationaleIndex().remove(`wi:${id}`);
}

/** Re-project a source by its tag object kind + ref (the `topics:tag` reaction). */
export async function reprojectTagged(objectKind: string, objectRef: string): Promise<void> {
  if (objectKind === 'plan') return reprojectPlan(objectRef);
  if (objectKind === 'feature' || objectKind === 'issue') {
    // feature refs are harness-qualified `<harness>#<id>`; issue refs are bare.
    const hash = objectRef.indexOf('#');
    if (hash >= 0) return reprojectWorkItem(objectRef.slice(hash + 1), objectRef.slice(0, hash));
    return reprojectWorkItem(objectRef);
  }
  // conversation / other taggables don't contribute rationale — ignore.
}

/** Upsert every insight into the index (insights have no per-file event). */
export async function reprojectInsights(): Promise<number> {
  const sources = await gatherAllInsightSources();
  const idx = getRationaleIndex();
  for (const src of sources) await idx.index(sourceIdOf(src), src);
  return sources.length;
}

// --- bulk (re)build ---

export interface BackfillResult {
  plans: number;
  workItems: number;
  insights: number;
}

/**
 * (Re)build the whole projection from scratch. Gathers every plan, tagged
 * work-item, and insight and re-indexes them. Idempotent — re-running converges to
 * the same index (each source diffs against its own prior contributions). Used at
 * startup (lazy, when empty) and on demand via `rationale:reproject { kind:'all' }`.
 */
export async function backfillAll(): Promise<BackfillResult> {
  const idx = getRationaleIndex();
  const plans = await gatherAllPlanSources();
  for (const src of plans) await idx.index(sourceIdOf(src), src);

  const workItems = await gatherTaggedWorkItemSources();
  for (const src of workItems) await idx.index(sourceIdOf(src), src);

  const insights = await gatherAllInsightSources();
  for (const src of insights) await idx.index(sourceIdOf(src), src);

  return { plans: plans.length, workItems: workItems.length, insights: insights.length };
}

// --- read path (rationale:feed) ---

export interface QueryTopicOptions extends QueryOptions {}

/** Every rationale entry under a topic — the `rationale:feed` read path. */
export function queryTopic(
  topic: string,
  opts?: QueryTopicOptions,
): Promise<IndexedEntry<RationaleEntry>[]> {
  return getRationaleIndex().query(topic, opts);
}
