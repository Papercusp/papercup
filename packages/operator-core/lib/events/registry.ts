/**
 * The reaction rule registry — the single inspectable Events registry
 * (event-reaction-system D-002). One `@papercusp/event-reaction`
 * `ReactionRegistry` (itself over a `@papercusp/rules` `RulesEngine`), indexed by
 * trigger tool, holding every reaction rule from every source: the built-in
 * Events file (`./rules`), `emits:` co-location sugar (coord-lifecycle-automation
 * D-002), and plugin/blueprint-contributed rules (D-012).
 *
 * This module is the PUBLIC registration boundary other subsystems build on —
 * `registerReactionRule` is the stable API the `emits` desugar calls. The registry
 * is anchored on `globalThis` so every importer (and both the tsx runtime and a
 * vitest module graph) shares ONE registry instance. (The lib intentionally does
 * NOT anchor a singleton — process-wide sharing is this host's concern.)
 */

import type { MatchedAction } from '@papercusp/rules';
import { ReactionRegistry } from '@papercusp/event-reaction';
import type { ReactionRule, ToolInvocationEvent } from './types';

type ReactionEngine = ReactionRegistry<ToolInvocationEvent, string>;

const GLOBAL_KEY = '__papercuspReactionEngine__';

/** The wildcard trigger key every `<schema>.<table>.changed` event also matches. */
export const TABLE_CHANGED_KEY = '*.changed';

/**
 * The trigger key(s) an event matches rules on. The primary key is the event's
 * `tool` (the rule index, e.g. `coord:handoff` or `harness_shared.harness_plans.changed`).
 *
 * A table-change event (`<schema>.<table>.changed`, emitted from the sync change
 * stream via `emitSystemEvent`) ALSO matches the wildcard `'*.changed'` key — so a
 * single rule keyed on `'*.changed'` reacts to a change on ANY table without
 * enumerating the open-ended table set (caching-layer-tag-eca-2026-06-22 P-004:
 * the cache-invalidation rule reads the concrete table off `e.tool`).
 */
function keyOf(event: ToolInvocationEvent): string | string[] {
  if (event.tool.endsWith('.changed')) return [event.tool, TABLE_CHANGED_KEY];
  return event.tool;
}

function engine(): ReactionEngine {
  const g = globalThis as Record<string, unknown>;
  let e = g[GLOBAL_KEY] as ReactionEngine | undefined;
  if (!e) {
    e = new ReactionRegistry<ToolInvocationEvent, string>({
      keyOf,
      onError: (err, rule) => {
         
        console.warn(
          `[events] rule "${rule.id}" condition threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    });
    g[GLOBAL_KEY] = e;
  }
  return e;
}

/**
 * Register an event-reaction rule. Idempotent by `rule.id` (re-registering the
 * same id replaces). Safe to call at module-load. THE public API the `emits`
 * desugar + plugin/blueprint contributions call.
 *
 * ⚠ EI-6980 — your `when`/`args` sees ONE PER-ITEM event, never the bulk envelope.
 * Every agent-facing bulk-capable tool returns `{ ok, results: [...], counts }`
 * (`runBulk`/`bulkContent`), even for a single-item call — but `matchAndRun`
 * (`./engine.ts`'s `fanOutBulkEvent`, D-007) explodes that envelope into one
 * synthetic event PER RESULT ITEM before matching, and never matches the bulk
 * carrier itself. So `e.result.data` in your rule is always a single flat
 * per-item record (e.g. `{ workItem, completion, ... }`) — a rule written to
 * read `e.result.data.results[]` matches NOTHING, silently, with no error
 * (reconcile-rule.ts sat dead this way — EI-5925/EI-6960). Read the per-item
 * shape directly, the way `./reflect-rules.ts` does (`data.workItem`).
 */
export function registerReactionRule(rule: ReactionRule): void {
  engine().add(rule);
}

/** Remove a rule by id. Returns true if one was removed. */
export function unregisterReactionRule(id: string): boolean {
  return engine().remove(id);
}

/** Every registered rule — inspectability / the reactive-graph view (D-010). */
export function listReactionRules(): ReactionRule[] {
  return engine().rules();
}

/** Rules registered on a given trigger tool. */
export function reactionRulesFor(tool: string): ReactionRule[] {
  return engine().rulesFor(tool);
}

/** Match an event → the reaction actions that should fire (pure). */
export function matchReactions(event: ToolInvocationEvent): Array<MatchedAction<ToolInvocationEvent, string>> {
  return engine().match(event);
}

/** The reactive graph as `{ on, ruleId, fire }` edges — the "what fires what" view (D-010). */
export function reactionGraph(): Array<{ on: string; ruleId: string; fire: string }> {
  return engine().describe();
}

/** Test-only: empty the registry. */
export function _resetReactionsForTests(): void {
  engine().clear();
}
