/**
 * work-item-blocking — the dependency/readiness SEAM (work-item-deps-and-readiness-2026-06-22 P-001).
 *
 * Consumers (the scheduler's get_next/claim path, the Queen survey, the readiness column
 * maintainer) call THIS, never the dependency table directly. That decouples them from where
 * blocking is stored, so the storage can evolve — coord_links rel='blocks' TODAY → a dedicated
 * `work_item_deps` table (P-002/P-003) → FK to the unified work_items base table (P-009) — without
 * rewriting a single consumer.
 *
 * The READINESS LOGIC is the existing pure predicate in dbos/frontier-readiness.ts (the "one
 * frontier, two views" keystone) — reused verbatim, NOT forked. This module adds (a) the storage
 * seam, and (b) the cross-family terminal set that fixes F2: a feature is terminal at
 * passed/deprecated, an ISSUE at resolved/closed — so an issue blocking a feature counts as
 * satisfied when resolved (the shared predicate previously only knew the feature set).
 */
import { getFeatureBlockers } from './dbos/feature-blockers-edges';
import { getWorkItemDepBlockers } from './dbos/work-item-deps-store';
import { selectReady, TERMINAL_STATUSES, type ReadinessNode } from './dbos/frontier-readiness';

/** Issue-family terminal statuses (work-items.ts ISSUE_FAMILY_STATES: open/resolved/closed). */
export const ISSUE_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['resolved', 'closed']);

/**
 * Cross-family terminal set (F2): feature {passed,deprecated} ∪ issue {resolved,closed}. A blocker
 * in EITHER family is "satisfied" when terminal in its own vocabulary. (Dissolved entirely once the
 * work-item unification gives one state vocabulary — P-009 — but correct in the interim.)
 */
export const ALL_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  ...TERMINAL_STATUSES,
  ...ISSUE_TERMINAL_STATUSES,
]);

/** A work-item's minimal identity for readiness (canonical, prefix-stripped id + its status). */
export interface BlockingNode {
  id: string;
  status: string;
}

/**
 * The dependency STORAGE seam. One method: given a harness, return blocked-id → blocker-ids.
 * Swap the implementation (coord_links → work_item_deps → FK) without touching consumers.
 */
export interface BlockingStore {
  /** blocked id → its blocker ids, within `harnessSlug` (within-harness, prefix-stripped). */
  blockersFor(harnessSlug: string): Promise<Map<string, string[]>>;
}

/**
 * Current backend: coord_links rel='blocks' (feature→feature), via the existing reader.
 * P-002/P-003 introduce `workItemDepsBlockingStore` and flip this one constant.
 */
export const coordLinksBlockingStore: BlockingStore = {
  blockersFor: (harnessSlug: string) => getFeatureBlockers(harnessSlug),
};

/**
 * NEW backend: the dedicated `work_item_deps` table (P-002). The seam flips its DEFAULT to this once
 * the backfill + dual-write land (the P-003 cutover); `coordLinksBlockingStore` remains the default
 * until then so reads stay correct during the transition. Exposed now so the cutover is a one-line swap.
 */
export const workItemDepsBlockingStore: BlockingStore = {
  blockersFor: (harnessSlug: string) => getWorkItemDepBlockers(harnessSlug),
};

/**
 * The seam's CURRENT default backend. P-003 flips this to `workItemDepsBlockingStore`. Consumers that
 * don't inject a store use this — the single switch point for the coord_links → work_item_deps cutover.
 */
export const defaultBlockingStore: BlockingStore = coordLinksBlockingStore;

/** Build readiness nodes from items + a blocker map (pure). */
export function toReadinessNodes(
  items: readonly BlockingNode[],
  blockers: ReadonlyMap<string, readonly string[]>,
): ReadinessNode[] {
  return items.map((it) => ({
    id: it.id,
    status: it.status,
    blockedBy: blockers.get(it.id) ?? [],
  }));
}

/**
 * Partition items into ready/blocked over a blocker map, using the cross-family terminal set.
 * Pure — the DB-coupled part is fetching `items` + `store.blockersFor(...)`; this composes them
 * with the shared `selectReady` predicate so the claim path and the survey share ONE readiness.
 */
export function partitionReady(
  items: readonly BlockingNode[],
  blockers: ReadonlyMap<string, readonly string[]>,
  dispatchable: ReadonlySet<string>,
  owned: ReadonlySet<string> = new Set<string>(),
): { ready: ReadinessNode[]; blocked: ReadinessNode[] } {
  return selectReady(toReadinessNodes(items, blockers), owned, dispatchable, ALL_TERMINAL_STATUSES);
}

/** Is one item ready right now, given the full node set + the blocker map? (Convenience over partitionReady.) */
export function isReady(
  itemId: string,
  items: readonly BlockingNode[],
  blockers: ReadonlyMap<string, readonly string[]>,
  dispatchable: ReadonlySet<string>,
  owned: ReadonlySet<string> = new Set<string>(),
): boolean {
  return partitionReady(items, blockers, dispatchable, owned).ready.some((n) => n.id === itemId);
}
