/**
 * In-process re-dispatch helper for COMPOUND tools (code-execution-tool-orchestration
 * B-CX-1B).
 *
 * A compound tool collapses a hot, FIXED multi-step agent flow (measured from
 * harness_shared.tool_invocations) into ONE call — the cheap/safe complement to
 * `code:run`. Where `code:run` runs an arbitrary script, a compound tool composes a
 * KNOWN sequence of existing tools server-side and returns a summary, so the agent
 * pays ONE inference round-trip instead of N (each its own model call re-reading the
 * whole context).
 *
 * Composition routes each sub-call through the SAME dispatcher pipeline every MCP
 * `tools/call` uses (role/capability/envelope gates, quota, authorize, telemetry,
 * audit, event-reactions) via `dispatchProjectedTool` + the host's real
 * `PROJECTED_DEPS` — the in-process re-dispatch pattern from
 * `events/dispatch-reaction.ts` (and the same deps `code:run` threads after B-CX-DEPS).
 * So a compound tool is just another caller of the dispatcher: each sub-step is
 * independently gated + recordInvocation-logged (visible to spend), not a parallel
 * tool path that bypasses the gates.
 */
import {
  lookupByMcpName,
  dispatchProjectedTool,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { PROJECTED_DEPS } from '../projected-tool-deps';

/**
 * The injected inner-dispatch a compound's pure composition fn calls. Returns the
 * UNWRAPPED sub-tool payload (the plain data the tool's ToolResult carried), so the
 * composition reads `result.workItem` / `result.ok`, not `result.content[0].text`.
 * THROWS on a dispatch/gate failure (so the compound's caller surfaces it); a sub-tool
 * that returns a business-level `{ ok:false, error }` resolves normally — the
 * composition inspects that payload itself.
 */
export type InnerCall = (name: string, args: unknown) => Promise<unknown>;

/** Unwrap a settled ToolResult into the plain value the composition should see.
 *  Mirrors tooldef's `unwrapToolResult` (cast-in-guard so the strict content union
 *  assigns cleanly): structuredContent if present, else the JSON-parsed text payload,
 *  else the raw text/result. */
function unwrap(
  result: { structuredContent?: unknown; content?: ReadonlyArray<unknown> } | undefined,
): unknown {
  if (!result) return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const textItem = result.content?.find(
    (c): c is { text: string } => typeof (c as { text?: unknown }).text === 'string',
  );
  if (!textItem) return result;
  try {
    return JSON.parse(textItem.text);
  } catch {
    return textItem.text;
  }
}

/**
 * Build the in-process `InnerCall` for a compound tool's handler, bound to the
 * caller's ctx. Each sub-call re-runs the full dispatch stack against that ctx, so
 * the agent can only compose tools it could call directly.
 */
export function inProcessCall(ctx: UnifiedToolContext): InnerCall {
  return async (name, args) => {
    const tool = lookupByMcpName(name);
    if (!tool) throw new Error(`compound: tool "${name}" is not registered`);
    const r = await dispatchProjectedTool(tool, name, args, ctx, PROJECTED_DEPS);
    if (!r.ok) {
      throw new Error(
        `${name} failed [${r.error?.code ?? 'error'}]: ${r.error?.message ?? 'unknown error'}`,
      );
    }
    return unwrap(r.result);
  };
}
