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

export default defineTool({
  name: 'tools:invoke',
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
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    /** Exact MCP tool name in colon form, e.g. "flags:set". */
    name: z.string().min(1).max(120),
    /** The target tool's arguments object (its own schema). Defaults to {}. */
    args: z.record(z.string(), z.unknown()).optional(),
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
    // dispatchTool returns an MCP-shaped result already ({ content, isError?, _meta?, structuredContent? }).
    return result as unknown as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
  },
});
