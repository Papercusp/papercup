/**
 * plan-parts/federation — capture + apply for per-part plan federation
 * (plan-federation-regrain-2026-06-13 P-003). Pure over an injected
 * {@link PlanPartsStore}; the LWW lives in the store. DARK until cutover.
 *
 * - `capturePlanParts`  : a local plan write → decompose (parts.ts) → diff vs the
 *   stored parts → persist the changed parts + tombstones → return the per-part
 *   ops to FEDERATE (one op per changed item/decision/section, not the whole doc).
 * - `applyRemotePlanParts` : remote per-part ops → LWW-merge into the store →
 *   recompose the plan content (the caller upserts it into harness_plans.content).
 *
 * Because an op is scoped to ONE part key, concurrent edits to DIFFERENT parts
 * merge instead of clobbering — the whole point (D-009 of shared-hive-hardening).
 */
import {
  splitPlanIntoParts,
  diffPlanParts,
  joinFederatedParts,
  type FederatedPart,
  type PlanPart,
} from '@papercusp/plan-parser';
import type { PlanPartsStore } from './store';

/**
 * Capture a local plan-content write as per-part ops. Diffs the freshly-split
 * content against the store's current parts, stamps changed parts with `fedTs` +
 * `author`, persists them, and returns the ops to put on the peer-log.
 */
export async function capturePlanParts(
  store: PlanPartsStore,
  planSlug: string,
  content: string,
  fedTs: number,
  author: string,
): Promise<FederatedPart[]> {
  const prevMap = await store.getParts(planSlug);
  const prev: PlanPart[] = [...prevMap.values()].filter((p) => !p.tombstone);
  const next = splitPlanIntoParts(content);
  const { upserted, removedKeys } = diffPlanParts(prev, next);

  const ops: FederatedPart[] = [];
  for (const p of upserted) ops.push({ ...p, fedTs, author });
  for (const key of removedKeys) {
    const stale = prevMap.get(key);
    ops.push({
      key,
      kind: stale?.kind ?? 'item',
      text: '',
      order: stale?.order ?? 0,
      fedTs,
      author,
      tombstone: true,
    });
  }

  for (const op of ops) await store.upsertPart(planSlug, op);
  return ops;
}

/**
 * Apply remote per-part ops (LWW-merged by the store) and recompose the plan
 * content from the merged live parts. Returns the new content for the caller to
 * upsert into `harness_plans.content`. Order-independent (commutative).
 */
export async function applyRemotePlanParts(
  store: PlanPartsStore,
  planSlug: string,
  ops: readonly FederatedPart[],
): Promise<string> {
  for (const op of ops) await store.upsertPart(planSlug, op);
  return joinFederatedParts(await store.getParts(planSlug));
}
