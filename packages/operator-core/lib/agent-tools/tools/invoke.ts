/**
 * tools:invoke — call ANY tool in the ~550-tool catalog by name, without it
 * being in your loaded tool list (dynamic-tool-surface-2026-07-01, D-003).
 *
 * The universal reachability escape hatch that complements `tools:find`. On a
 * small-seed session, `tools:find("<intent>")` returns the target tool's exact
 * name + arg schema; `tools:invoke({ name, args })` then CALLS it — routed
 * server-side through the same dispatcher a direct call uses, so it is gated
 * EXACTLY as a direct call (same role-allowlist, quota, profile, privilege). It
 * is a router, NOT a privilege bypass.
 *
 * Why it exists even though the dynamic surface (tools/list_changed) already
 * expands OMP's list: a client that does NOT act on the notification never sees
 * the surfaced tool in its own registry, so it can't call it directly. Routing
 * through this one always-present meta-tool reaches the whole catalog regardless
 * — the reachability guarantee for Codex and any future client. Also handy for a
 * one-off call to an obscure tool without growing your working surface.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { DISPATCH_WRAPPER_METADATA_KEY } from '../sessions/automatic-tool-names';
import { dispatchWrapperMarkEnabled } from '../../telemetry-dispatch-wrapper';

type NestedOutcome = { effectiveStatus: 'ok' | 'partial' | 'error'; childFailureCount: number };

function decodedResultBodies(result: {
  content?: ReadonlyArray<unknown>;
  structuredContent?: unknown;
}): unknown[] {
  const bodies: unknown[] = [];
  if (result.structuredContent !== undefined) bodies.push(result.structuredContent);
  for (const item of result.content ?? []) {
    if (!item || typeof item !== 'object' || (item as { type?: unknown }).type !== 'text') continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text !== 'string') continue;
    try {
      bodies.push(JSON.parse(text));
    } catch {
      // Non-JSON encodings still carry isError; semantic JSON is the additive path here.
    }
  }
  return bodies;
}

export function summarizeNestedToolOutcome(result: {
  content?: ReadonlyArray<unknown>;
  isError?: boolean;
  structuredContent?: unknown;
}): NestedOutcome {
  if (result.isError) return { effectiveStatus: 'error', childFailureCount: 1 };
  let failures = 0;
  let successes = 0;
  for (const body of decodedResultBodies(result)) {
    if (!body || typeof body !== 'object') continue;
    const record = body as Record<string, unknown>;
    if (record.ok === false) failures += 1;
    else if (record.ok === true) successes += 1;
    if (record.partial === true) failures += 1;
    const counts = record.counts;
    if (counts && typeof counts === 'object') {
      const failed = Number((counts as Record<string, unknown>).failed ?? 0);
      const ok = Number((counts as Record<string, unknown>).ok ?? 0);
      if (Number.isFinite(failed) && failed > 0) failures += failed;
      if (Number.isFinite(ok) && ok > 0) successes += ok;
    }
  }
  if (failures === 0) return { effectiveStatus: 'ok', childFailureCount: 0 };
  return {
    effectiveStatus: successes > 0 ? 'partial' : 'error',
    childFailureCount: failures,
  };
}

export default defineTool({
  name: 'tools:invoke',
  // The target runs through its own projected dispatcher and therefore owns
  // the authoritative deadline. Keep this wrapper outside the longest agent-
  // tool deadline (600s) so its default 60s watchdog cannot abort first and
  // turn a successfully-completed target into the misleading
  // "handler returned but signal had aborted" timeout (EI-9242).
  timeoutSec: 660,
  description:
    'Call ANY tool in the full ~550-tool catalog by name, even one not in your loaded tool list. ' +
    'Pass the exact tool name (colon form, e.g. "flags:set") and its arguments object. The call is ' +
    'dispatched server-side and gated exactly as a direct call would be. Pair with tools:find: ' +
    'tools:find("<intent>") to get the name + arg schema, then tools:invoke({ name, args }) to run it. ' +
    'Use this when a tool you need is not in your loaded set and your client has not surfaced it directly.',
  guidance: {
    when:
      'You know (or just discovered via tools:find) the exact name of a tool that is NOT in your loaded ' +
      'set and you want to call it once — the universal way to reach the long tail of the catalog.',
    notWhen:
      'When the tool IS already in your loaded set / core spine — call it directly (lower overhead, ' +
      'the model constructs the call natively). This meta-tool adds a layer of indirection; prefer a ' +
      'direct call whenever the tool is reachable.',
    chaining:
      'tools:find("<intent>") → take the top hit\'s name + argSchema → tools:invoke({ name, args: {…} }).',
    seeAlso: [
      'tools:find (discover a tool by intent — returns names + schemas, and activates them where supported)',
    ],
  },
  capability: 'agent_tools:read',
  requirePrincipal: false,
  // EI-18803497769946984: this handler is a PURE DELEGATOR — it never touches
  // `ctx.tx`, it just awaits `ctx.dispatchTool(...)`. Without this flag it holds a
  // workspace transaction open for the ENTIRE inner tool's runtime, so dispatching
  // any slow target (build:typecheck, release:deploy, testing:run) leaves that tx
  // IDLE past idle_in_transaction_session_timeout (60s here). Postgres then kills the
  // backend, PgBouncer reports "server conn crashed?", and the caller sees a bare
  // `write CONNECTION_CLOSED 127.0.0.1:6432` at ~60s — an error that reads as an infra
  // outage but is really this ambient tx timing out.
  //
  // ⚠ This is WHY fixing only the inner tool was not enough. release:deploy and
  // capability:bash already carry skipWorkspaceTx, yet tools:invoke→<them> kept
  // failing at ~60s, because the OUTER delegator still held its own tx (each incident
  // killed a PAIR of backends from one process — outer + inner). Measured: 33 of 33
  // ~60s handler_error kills in the trailing 7d were tools:invoke.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    /** Exact MCP tool name in colon form, e.g. "flags:set". */
    name: z.string().min(1).max(120),
    // EI-6681 / EI-15360: some MCP clients intermittently stringify a
    // moderately-long/complex nested `args` object before it reaches this schema
    // (root cause client-side — this server's own dispatch path never stringifies
    // it; see the endpoint-system docs). A preprocess step tolerates that: a STRING
    // value is JSON.parsed before the record check, so a client-side serialization
    // quirk degrades to a normal call instead of a client-facing "expected record,
    // received string" failure with no actionable next step.
    //
    // EI-15360: for a DEEPLY-NESTED payload (e.g. scheduler:set_claim_spec's ~10-level
    // boolean filter tree) some clients DOUBLE-encode — the value arrives as the JSON
    // of a JSON string. A single JSON.parse then yields a *string*, which still fails
    // z.record with the exact same "expected record, received string" error. Un-string
    // ITERATIVELY (bounded, so a pathological input can't loop) so a double-/multi-
    // encoded object is recovered too. We only un-string the TOP-LEVEL args value —
    // never nested values — so a target tool's legitimate string arg (a title, body,
    // or a JSON-blob-as-string) is left untouched. A non-JSON string still fails
    // naturally (parse throws → the last string reaches the record check).
    /** The target tool's arguments object (its own schema). Defaults to {}. */
    args: z
      .preprocess((v) => {
        let cur = v;
        for (let i = 0; i < 5 && typeof cur === 'string'; i++) {
          try {
            cur = JSON.parse(cur);
          } catch {
            break;
          }
        }
        return cur;
      }, z.record(z.string(), z.unknown()))
      .optional(),
  }),
  async handler(args, ctx) {
    const name = args.name.trim();
    // Guard the obvious foot-gun: routing tools:invoke through itself.
    if (name === 'tools:invoke') {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: 'invalid_target: tools:invoke cannot invoke itself' }],
      };
    }
    if (!ctx.dispatchTool) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: 'unsupported_transport: tools:invoke requires a server-side dispatcher (MCP transport)',
        }],
      };
    }
    const result = await ctx.dispatchTool(name, args.args ?? {});
    const outcome = summarizeNestedToolOutcome(result);
    // P-012 (census double-count): the inner dispatch above wrote its OWN telemetry
    // row, so this row is the wrapper overhead — mark it so tool_name censuses
    // exclude it by default. Set only after dispatchTool settled: a throw before
    // dispatch (unknown tool) leaves this row unmarked, erring toward counting.
    // ctx.metadata is overwrite-not-merge, so the mark rides the one existing call.
    const wrapperMark = (await dispatchWrapperMarkEnabled())
      ? { [DISPATCH_WRAPPER_METADATA_KEY]: true, dispatchedTool: name }
      : {};
    ctx.metadata?.({
      ...outcome,
      ...(outcome.childFailureCount > 0 ? { childFailureRefs: [name] } : {}),
      ...wrapperMark,
    });
    // dispatchTool returns an MCP-shaped result already ({ content, isError?, _meta?, structuredContent? }).
    return result as unknown as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
  },
});
