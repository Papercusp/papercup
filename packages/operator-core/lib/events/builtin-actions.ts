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

import type { FireReactionResult } from './dispatch-reaction';
import { getOperatorCache } from '../cache/instance';

/** The action name the cache-invalidation reaction fires. */
export const CACHE_BUMP_TAGS_ACTION = 'cache.bumpTags';

/** The closed set of recognised built-in (non-tool) reaction action names. */
export const BUILTIN_ACTIONS: ReadonlySet<string> = new Set<string>([CACHE_BUMP_TAGS_ACTION]);

/** Whether `fire` names a built-in in-process action (vs a projected tool). */
export function isBuiltinReactionAction(fire: string): boolean {
  return BUILTIN_ACTIONS.has(fire);
}

/** Coerce an args value to a clean string[] of tags (drop empties / non-strings). */
function toTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is string => typeof t === 'string' && t.length > 0);
}

/**
 * Run a built-in reaction action in-process. Never throws — returns
 * `{ ok:false, error }` on a bad/unknown action so the engine can log it.
 *
 * `cache.bumpTags { tags: string[] }` — bumps the per-(workspace, tag)
 * generation for each tag on the operator's singleton cache, lazily marking
 * every `getOrSet` entry carrying any of those tags stale on its next read. The
 * workspace is the trigger's (D-010): tags never cross a workspace boundary.
 */
export function fireBuiltinReactionAction(
  fire: string,
  args: Record<string, unknown>,
  workspaceId: string,
): FireReactionResult {
  switch (fire) {
    case CACHE_BUMP_TAGS_ACTION: {
      const tags = toTags(args.tags);
      if (tags.length === 0) {
        // No tags ⇒ nothing to invalidate. Not an error (a change on an
        // untagged/unmapped table legitimately bumps nothing).
        return { ok: true };
      }
      try {
        getOperatorCache().invalidateByTags(workspaceId, tags);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    default:
      return { ok: false, error: `unknown built-in reaction action "${fire}"` };
  }
}
