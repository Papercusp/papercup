/**
 * The event-reaction system (event-reaction-system-2026-06-04).
 *
 * A declarative "when tool X settles, when <condition>, fire tool Y with
 * <derived args>" layer over the one `defineTool` dispatcher. The generic engine
 * lives in `@papercusp/event-reaction` (generalize-libs-to-generic-2026-06-05
 * D-003 #1); this module is the Papercusp adapter — it binds the engine to the
 * operator's tool events, dispatcher, durable runner, and PG dedup ledger.
 * Importing this module:
 *   1. registers the built-in Events-file rules (`./rules`);
 *   2. wires the dispatcher's post-invocation hook (`PROJECTED_DEPS.postInvoke`)
 *      to the reaction engine.
 *
 * Imported once at startup from the agent-tools bootstrap. Idempotent.
 */

import { setReactionPostInvoke } from '../projected-tool-deps';
import { handleToolInvoked } from './engine';
import './rules';

// Wire the single observation point. The dispatcher now calls handleToolInvoked
// after every tool settles (best-effort, non-blocking).
setReactionPostInvoke(handleToolInvoked);

export {
  registerReactionRule,
  unregisterReactionRule,
  listReactionRules,
  reactionRulesFor,
  matchReactions,
  reactionGraph,
  _resetReactionsForTests,
} from './registry';
export { handleToolInvoked, normalizeEvent } from './engine';
// The loop guard is the generic engine's (algorithm) — re-exported for back-compat.
export { guardReaction, MAX_REACTION_DEPTH } from '@papercusp/event-reaction';
export { formatHandoff, type HandoffArgs } from './format-handoff';
export { fireReactionInProcess, buildReactionCtx } from './dispatch-reaction';
export {
  durableReactionsEnabled,
  runDurableReaction,
  setDurableReactionRunner,
  type DurableReactionInput,
} from './durable';
export { executeDurableReaction, type DurableReactionPayload } from './durable-exec';
export { serializeParent, computeDedupId, type SerializableReactionParent } from './reaction-id';
export { claimReaction, releaseReaction, markReactionFailed, type ReactionClaim } from './reaction-dedup';
export type { ToolInvocationEvent, ReactionRule, ReactionCause, ReactionMode } from './types';
