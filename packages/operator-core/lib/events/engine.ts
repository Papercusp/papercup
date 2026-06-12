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
  try {
    event = normalizeEvent(pe);
  } catch (err) {
    // Normalization must never break the trigger. (Pure code; defensive.)
    // eslint-disable-next-line no-console
    console.warn(`[events] normalize failed for ${pe.toolName}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  matchAndRun(event);
}

/**
 * Feed a SYNTHETIC (non-tool) event into the same matcher + reaction scheduler
 * (event-reaction-system D-013: the dispatcher is the *primary* source, but the
 * one matcher accepts other sources normalized to the same shape).
 *
 * This is how non-tool fire-points — blueprint-spine step transitions, the
 * work_items lifecycle, plugin-emitted events — reach reaction rules
 * (plugin-system-hive-port D-003: new pipeline fire-points are event emissions
 * only). `tool` is the rule index key (e.g. `pipeline:step-done`); `data`
 * becomes `result.data` so the same data-matcher grammar applies. A minimal
 * system ctx scopes downstream reactions (workspace / harness inheritance).
 * Never throws.
 */
export function emitSystemEvent(opts: {
  /** The rule index key, e.g. `pipeline:step-done` or `myplugin.cache-warm`. */
  tool: string;
  /** Event payload — matched as both `args` and `result.data`. */
  args?: Record<string, unknown>;
  /** Scope for downstream reactions. Defaults to the active workspace, harness '*'. */
  workspaceId?: string;
  harnessSlug?: string;
  /** Cause-chain when the emission itself was caused by a reaction. */
  cause?: ToolInvocationEvent['cause'];
}): void {
  let event: ToolInvocationEvent;
  try {
    const ctx = {
      workspaceId: opts.workspaceId ?? activeWorkspaceId(),
      harnessSlug: opts.harnessSlug ?? '*',
      role: 'operator',
      featureId: null,
      chunkId: null,
      runId: globalThis.crypto.randomUUID(),
      spawnId: 'system-event',
      parentSpawnId: null,
      uiClientId: null,
      isSuperuser: false,
      profile: 'engineer',
      transport: 'in_process',
      log: () => {},
      progress: () => {},
      emit: () => {},
      signal: new AbortController().signal,
    } as unknown as UnifiedToolContext;
    event = {
      tool: opts.tool,
      args: opts.args ?? {},
      result: { ok: true, data: opts.args ?? {} },
      ctx,
      ...(opts.cause ? { cause: opts.cause } : {}),
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[events] system-event build failed for ${opts.tool}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  matchAndRun(event);
}

/** Shared match + schedule tail for both event sources. Never throws. */
function matchAndRun(event: ToolInvocationEvent): void {
  let actions: Array<MatchedAction<ToolInvocationEvent, string>>;
  try {
    actions = matchReactions(event);
  } catch (err) {
    // Matching must never break the trigger. (Pure code; defensive.)
    // eslint-disable-next-line no-console
    console.warn(`[events] match failed for ${event.tool}: ${err instanceof Error ? err.message : String(err)}`);
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
