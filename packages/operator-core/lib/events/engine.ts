/**
 * The event-reaction engine binding: the host's `postInvoke` handler.
 *
 * Flow per tool invocation (event-reaction-system D-001 → D-005):
 *   1. normalize the dispatcher's PostInvokeEvent → a ToolInvocationEvent;
 *   2. match it against the rule registry (pure, indexed — O(rules-for-tool),
 *      and instant when a tool has no rules, the overwhelmingly common case);
 *   3. hand the matched actions to the generic engine's `runReactions`, which
 *      applies the success gate + loop guard and schedules each reaction off the
 *      hot path (in-process, or a durable DBOS workflow when enabled).
 *
 * `handleToolInvoked` is synchronous up to the schedule point; the dispatcher
 * calls it without awaiting (see DispatchProjectedDeps.postInvoke), so a reaction
 * can never delay or break its trigger. The generic decision/scheduling logic
 * lives in `@papercusp/event-reaction`; this file injects the Papercusp ports —
 * the dispatcher (`fireReactionInProcess`) and the durable seam (`./durable`).
 */

import type { DispatchProjectedResult, PostInvokeEvent, UnifiedToolContext } from '@papercusp/agent-mcp';
import type { MatchedAction } from '@papercusp/rules';
import { runReactions } from '@papercusp/event-reaction';
import { matchReactions } from './registry';
import { fireReactionInProcess } from './dispatch-reaction';
import { runDurableReaction, durableReactionsEnabled } from './durable';
import type { ToolInvocationEvent } from './types';
import { activeWorkspaceId } from '../workspace-registry';

/** Extract a tool's return value from its MCP-shaped ToolResult (parse JSON when possible). */
function extractData(result: DispatchProjectedResult): unknown {
  const content = result.result?.content;
  const text = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined)?.text : undefined;
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Build the normalized event a rule matches against. */
export function normalizeEvent(pe: PostInvokeEvent): ToolInvocationEvent {
  return {
    tool: pe.toolName,
    args: pe.args,
    result: pe.result.ok
      ? { ok: true, data: extractData(pe.result) }
      : {
          ok: false,
          error: pe.result.error ? { code: pe.result.error.code, message: pe.result.error.message } : undefined,
        },
    ctx: pe.ctx,
    cause: pe.ctx.reactionCause,
  };
}

/** The host's `postInvoke` — match rules + schedule reactions. Never throws. */
export function handleToolInvoked(pe: PostInvokeEvent): void {
  let event: ToolInvocationEvent;
  let actions: Array<MatchedAction<ToolInvocationEvent, string>>;
  try {
    event = normalizeEvent(pe);
    actions = matchReactions(event);
  } catch (err) {
    // Matching must never break the trigger. (Pure code; defensive.)
    // eslint-disable-next-line no-console
    console.warn(`[events] match failed for ${pe.toolName}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (actions.length === 0) return;

  // Hand off to the generic engine. It owns success-gate + loop-guard + the
  // durable-vs-in-process scheduling (with in-process fallback); we inject the
  // Papercusp dispatcher + durable seam and map our event fields onto its ports.
  runReactions<ToolInvocationEvent, string>({
    actions,
    event,
    succeeded: event.result.ok,
    cause: event.cause,
    rootRunId: event.ctx.runId ?? null,
    fireInProcess: ({ fire, args, event: ev, cause, capability }) =>
      fireReactionInProcess({ fire, args, parentCtx: ev.ctx, cause, capability }),
    durable: { enabled: durableReactionsEnabled, run: (input) => runDurableReaction(input) },
    log: (msg) => console.warn(`[events] ${msg}`),
  });
}
