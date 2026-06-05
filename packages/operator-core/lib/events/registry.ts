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

function engine(): ReactionEngine {
  const g = globalThis as Record<string, unknown>;
  let e = g[GLOBAL_KEY] as ReactionEngine | undefined;
  if (!e) {
    e = new ReactionRegistry<ToolInvocationEvent, string>({
      keyOf: (event) => event.tool,
      onError: (err, rule) => {
        // eslint-disable-next-line no-console
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
