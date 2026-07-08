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
import { decode, type ResultFormat } from '@papercusp/result-encoding';
import { PROJECTED_DEPS } from '../projected-tool-deps';

/**
 * A self-identifying compact body prefixes its text with `format: <fmt>\n`
 * (serialize-result.ts). We decode ONLY `toon` here: it is LOSSLESS, so the
 * composition gets back the exact structured value (booleans/numbers intact).
 * `csv`/`tsv` are deliberately NOT decoded — they are type-lossy (every cell
 * becomes a string, so `.ok`/`.count` would read as strings) and, being
 * flat-scalar-array read formats, never arise on the in-process compound path
 * (the transport:'in_process' stamp keeps sub-results lossless JSON regardless).
 * A csv/tsv/md-marked body therefore falls through to the raw-text fallback.
 */
const COMPACT_MARKER_RE = /^format:\s*(toon)\n/;

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
 *  assigns cleanly): structuredContent if present, else the decoded text payload,
 *  else the raw text/result.
 *
 *  The text payload is normally lossless JSON on the in-process transport (see
 *  `inProcessCall` below, which stamps transport:'in_process' precisely so the
 *  dispatcher does NOT re-encode it to compact). But we ALSO decode a
 *  self-identifying compact body (`format: toon|csv|tsv\n…`) as defense in depth:
 *  if any path ever hands this seam a compact result, the composition still gets
 *  the structured value — never an opaque string it would misread (the
 *  templates:new-app 422-on-success class, owner-hit 2026-07-08). */
function unwrap(
  result: { structuredContent?: unknown; content?: ReadonlyArray<unknown> } | undefined,
): unknown {
  if (!result) return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const textItem = result.content?.find(
    (c): c is { text: string } => typeof (c as { text?: unknown }).text === 'string',
  );
  if (!textItem) return result;
  const text = textItem.text;
  // Self-identifying compact body → decode losslessly to the structured value.
  const marker = COMPACT_MARKER_RE.exec(text);
  if (marker) {
    try {
      return decode(text.slice(marker[0].length), marker[1] as ResultFormat);
    } catch {
      return text;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Build the in-process `InnerCall` for a compound tool's handler, bound to the
 * caller's ctx. Each sub-call re-runs the full dispatch stack against that ctx, so
 * the agent can only compose tools it could call directly.
 */
export function inProcessCall(ctx: UnifiedToolContext): InnerCall {
  // The re-dispatch is IN-PROCESS, not the agent-facing MCP transport. Reuse the
  // caller's ctx (its auth/scope/quota/harness) but stamp transport:'in_process'
  // so the sub-tool result stays LOSSLESS JSON. Both the format contract
  // (serialize-result.ts `formatOptsFromCtx`: defaultCompact = transport==='mcp')
  // AND define-tool's `reencodableJsonPayload` re-encode gate key "keep the raw
  // bytes" on transport !== 'mcp' — and reencodableJsonPayload's own jsdoc names
  // THIS consumer ("inProcessCall's unwrap → JSON.parse") as one it must not
  // perturb. Inheriting the outer transport:'mcp' made the sub-result TOON-encoded
  // → unwrap fell back to a raw string → the composition misread .ok/.slug/.path
  // (templates:new-app returned a bogus 422 on a SUCCESSFUL harness:create, so the
  // template overlay never ran — owner-hit 2026-07-08, reproduced on the dev box).
  // Mirrors the sibling in-process re-dispatcher events/dispatch-reaction.ts.
  const innerCtx: UnifiedToolContext = { ...ctx, transport: 'in_process' };
  return async (name, args) => {
    const tool = lookupByMcpName(name);
    if (!tool) throw new Error(`compound: tool "${name}" is not registered`);
    const r = await dispatchProjectedTool(tool, name, args, innerCtx, PROJECTED_DEPS);
    if (!r.ok) {
      throw new Error(
        `${name} failed [${r.error?.code ?? 'error'}]: ${r.error?.message ?? 'unknown error'}`,
      );
    }
    return unwrap(r.result);
  };
}
