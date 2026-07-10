/**
 * Built-in NON-TOOL reaction actions (caching-layer-tag-eca-2026-06-22 P-004).
 *
 * A reaction `fire` is *usually* a projected-tool MCP name dispatched through the
 * auth/quota/audit dispatcher (`dispatch-reaction.ts`). But some first-party
 * reactions are pure in-process side effects with no tool surface — invalidating
 * the operator's cache is the motivating one. Routing a cache bump through a
 * projected tool would be ceremony with no payoff (no caller args to validate, no
 * capability to gate, no audit row worth keeping per table-change).
 *
 * So the dispatch layer recognises a small, closed set of `<group>.<verb>`
 * built-in action names HERE and runs them directly. They are workspace-scoped
 * (the caller resolved the workspace from the trigger ctx) and never throw —
 * they return the same `{ ok, error }` shape the engine logs.
 *
 * Today the set is exactly `cache.bumpTags`. Add a new built-in by adding a case
 * to {@link fireBuiltinReactionAction} and its name to {@link BUILTIN_ACTIONS}.
 */

import type { FireReactionResult } from "./dispatch-reaction";
import { getOperatorCache } from "../cache/instance";
import { coalescedInvalidateByTags } from "../cache/debounced-invalidate";
import {
  reconcileLinkedWorkItemsForCompletedPlanItems,
  type CompletedPlanItem,
} from "../plan-items/reconcile-linked-work-items";

/** The action name the cache-invalidation reaction fires. */
export const CACHE_BUMP_TAGS_ACTION = "cache.bumpTags";

/** EI-5925: the action name plan-items/reconcile-rule.ts fires when one or more
 *  plan items just transitioned to `done`, to auto-resolve any OTHER work-item
 *  still pointing at them (the reverse mirror of reflect-rules.ts). */
export const PLAN_ITEM_RECONCILE_ACTION = "plan-item.reconcileLinkedWorkItems";

/** The closed set of recognised built-in (non-tool) reaction action names. */
export const BUILTIN_ACTIONS: ReadonlySet<string> = new Set<string>([
  CACHE_BUMP_TAGS_ACTION,
  PLAN_ITEM_RECONCILE_ACTION,
]);

/** Whether `fire` names a built-in in-process action (vs a projected tool). */
export function isBuiltinReactionAction(fire: string): boolean {
  return BUILTIN_ACTIONS.has(fire);
}

/** Coerce an args value to a clean string[] of tags (drop empties / non-strings). */
function toTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
}

/** Coerce an args value to a clean CompletedPlanItem[] (drop malformed entries). */
function toCompletedPlanItems(value: unknown): CompletedPlanItem[] {
  if (!Array.isArray(value)) return [];
  const out: CompletedPlanItem[] = [];
  for (const v of value) {
    if (
      v &&
      typeof v === "object" &&
      typeof (v as { planSlug?: unknown }).planSlug === "string" &&
      typeof (v as { itemId?: unknown }).itemId === "string"
    ) {
      const harnessSlug = typeof (v as { harnessSlug?: unknown }).harnessSlug === "string"
        ? (v as { harnessSlug: string }).harnessSlug
        : null;
      out.push({
        planSlug: (v as { planSlug: string }).planSlug,
        itemId: (v as { itemId: string }).itemId,
        harnessSlug,
      });
    }
  }
  return out;
}

/**
 * Run a built-in reaction action in-process. Never throws — returns
 * `{ ok:false, error }` on a bad/unknown action so the engine can log it.
 *
 * `cache.bumpTags { tags: string[] }` — bumps the per-(workspace, tag)
 * generation for each tag on the operator's singleton cache, lazily marking
 * every `getOrSet` entry carrying any of those tags stale on its next read. The
 * workspace is the trigger's (D-010): tags never cross a workspace boundary.
 *
 * Routed through `coalescedInvalidateByTags` (P-008/D-006): tags for the
 * APPEND-HEAVY log tables (coord_event_log, …) are DEBOUNCED — coalesced to at
 * most one bump per window — so an append storm can't tank a consumer's hit-rate;
 * every other tag bumps immediately, unchanged.
 *
 * `plan-item.reconcileLinkedWorkItems { completedItems: {planSlug,itemId}[] }`
 * (EI-5925) — for each just-completed plan item, auto-resolve any OTHER
 * work-item still linked to it (no independent in-flight progress). See
 * plan-items/reconcile-linked-work-items.ts. Always `{ok:true}` (the sweep is
 * internally fail-safe per item) unless the args are entirely malformed.
 */
export async function fireBuiltinReactionAction(
  fire: string,
  args: Record<string, unknown>,
  workspaceId: string,
): Promise<FireReactionResult> {
  switch (fire) {
    case CACHE_BUMP_TAGS_ACTION: {
      const tags = toTags(args.tags);
      if (tags.length === 0) {
        // No tags ⇒ nothing to invalidate. Not an error (a change on an
        // untagged/unmapped table legitimately bumps nothing).
        return { ok: true };
      }
      try {
        coalescedInvalidateByTags(getOperatorCache(), workspaceId, tags);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    case PLAN_ITEM_RECONCILE_ACTION: {
      const items = toCompletedPlanItems(args.completedItems);
      if (items.length === 0) return { ok: true };
      await reconcileLinkedWorkItemsForCompletedPlanItems(items);
      return { ok: true };
    }
    default:
      return { ok: false, error: `unknown built-in reaction action "${fire}"` };
  }
}
