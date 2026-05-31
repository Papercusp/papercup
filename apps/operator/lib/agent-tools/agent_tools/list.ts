/**
 * agent_tools:list — list every MCP-exposed tool with an `allowed` flag
 * for the calling context. Companion to `tools/list` (which strips the
 * gating metadata): this surfaces the role allowlist, capability gate,
 * tier, and quota windows so an agent can introspect *why* a tool would
 * succeed or fail before invoking it.
 *
 * `allowed` is conservative — if it's true the call would clear the
 * role + capability gates. Per-window quota is not consulted here
 * (it's stateful and changes per invocation).
 */

import { z } from 'zod';
import { defineTool, listAllProjectedTools } from '@papercusp/agent-mcp';

const ALL_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

export default defineTool({
  name: 'agent_tools:list',
  description:
    'List MCP-exposed tools with permission status for the caller. Each entry includes name, description, capability, roles allowlist, an `allowed` flag with `reason` when blocked, AND per-tool `guidance` (when/notWhen/chaining resolved for the queried role). Use to discover what you can call without trial-and-error.',
  capability: 'agent_tools:read',
  guidance: {
    when: 'Your tools playbook didn\'t cover a user request and you need to discover what\'s callable. Returns the full catalog filtered by your role, with each tool\'s guidance — treat this as the runtime fallback playbook.',
    notWhen: 'Don\'t use as a fishing expedition. If your playbook covers it, just call the tool. `agent_tools:list` costs a tool call.',
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    /** Optional substring/regex match on tool name. */
    filter: z.string().optional(),
    /** Limit; default 250. */
    limit: z.number().int().positive().max(500).optional(),
    /** Set false to also include tools the caller cannot invoke. Default true. */
    onlyAllowed: z.boolean().optional(),
    /**
     * Hypothetical role to evaluate `allowed` against. Defaults to the
     * caller's own role. Useful in superuser/operator shells: "what
     * would a worker see?" without spawning a real worker.
     */
    asRole: z.string().optional(),
  }),
  async handler(args, ctx) {
    // When asRole is supplied we evaluate the role allowlist against
    // that hypothetical role AND drop the isSuperuser bypass — the
    // caller is asking "what would this role see?", not "what can I
    // bypass right now?".
    const asRoleOverride = args.asRole && args.asRole.length > 0 ? args.asRole : null;
    const role = asRoleOverride ?? ctx.role;
    const isSuperuser = asRoleOverride ? false : ctx.isSuperuser === true;
    // In asRole simulation, also drop the principal — real spawned
    // agents at that role don't carry one, so the cap-gate would be
    // skipped for them. Without this, simulating asRole=worker from
    // an operator shell still triggers the cap-gate via the
    // synthesized operator principal, diverging from real worker calls.
    const effectivePrincipal = asRoleOverride ? null : ctx.principal ?? null;
    const principalCaps = effectivePrincipal?.capabilities ?? new Set<string>();

    const filterRe = args.filter ? safeRegex(args.filter) : null;
    const onlyAllowed = args.onlyAllowed ?? true;
    const limit = args.limit ?? 250;

    const out: Array<{
      name: string;
      description: string;
      capability: string | null;
      roles: readonly string[] | null;
      tier: string | null;
      timeoutSec: number | null;
      rolesQuota: Record<string, unknown> | null;
      allowed: boolean;
      reason: string | null;
      /**
       * Per-tool guidance, resolved against the queried role (i.e.
       * `byRole[role]` shallow-merged over the base). Null when the tool
       * has no guidance authored. This is the runtime playbook the model
       * consults when a tool isn't in `<role>.tools.md`. Phase 1a of the
       * tool-guidance arc.
       */
      guidance: { when?: string; notWhen?: string; chaining?: string } | null;
    }> = [];

    for (const tool of listAllProjectedTools()) {
      if (!tool.expose.mcp) continue;
      const name = tool.expose.mcp.name;
      if (filterRe && !filterRe.test(name)) continue;

      let allowed = true;
      let reason: string | null = null;

      // Role allowlist (skipped in superuser mode).
      if (!isSuperuser && tool.agentRoles && role && !tool.agentRoles.includes(role)) {
        allowed = false;
        reason = `role_not_allowed: tool requires one of [${tool.agentRoles.join(', ')}], caller is "${role}"`;
      }

      // Capability gate — only meaningful when a principal is attached
      // (i.e., the bearer resolved) AND we're not in superuser bypass.
      // Mirrors dispatchProjectedTool's check exactly:
      //   if (ctx.principal && !ctx.isSuperuser && tool.capabilities.length > 0)
      // — see packages/agent-mcp/src/dispatch-projected.ts:142.
      if (allowed && effectivePrincipal && !isSuperuser && tool.capabilities.length > 0) {
        const missing = tool.capabilities.filter((c) => !principalCaps.has(c));
        if (missing.length > 0) {
          allowed = false;
          reason = `missing_capability: principal lacks [${missing.join(', ')}]`;
        }
      }

      if (onlyAllowed && !allowed) continue;

      // Resolve per-role guidance: shallow-merge byRole[role] over base.
      // Returns null when the tool has no guidance OR when every resolved
      // field is empty — keeps the response payload small for the common
      // un-migrated case.
      const guidance = resolveProjectedGuidance(tool.guidance, role ?? null);

      out.push({
        name,
        description: tool.description,
        capability: tool.capabilities[0] ?? null,
        roles: tool.agentRoles ?? null,
        // tier is on the legacy ToolDefinition; ProjectedTool doesn't carry it
        // — leave null for now, callers can grep the manifest if they care.
        tier: null,
        timeoutSec: tool.timeoutSec ?? null,
        rolesQuota: (tool.rolesQuota as Record<string, unknown> | undefined) ?? null,
        allowed,
        reason,
        guidance,
      });

      if (out.length >= limit) break;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            callerRole: role ?? null,
            isSuperuser,
            count: out.length,
            tools: out,
          }),
        },
      ],
    };
  },
});

function safeRegex(input: string): RegExp | null {
  try {
    return new RegExp(input, 'i');
  } catch {
    return null;
  }
}

/**
 * Resolve per-tool guidance for a specific role. Shallow-merges
 * `byRole[role]` over the base `{ when, notWhen, chaining }`. Returns
 * null when there's nothing to surface — keeps the response compact for
 * tools that haven't authored guidance yet.
 */
function resolveProjectedGuidance(
  raw:
    | {
        when?: string;
        notWhen?: string;
        chaining?: string;
        byRole?: Record<string, { when?: string; notWhen?: string; chaining?: string }>;
      }
    | undefined,
  role: string | null,
): { when?: string; notWhen?: string; chaining?: string } | null {
  if (!raw) return null;
  const base = { when: raw.when, notWhen: raw.notWhen, chaining: raw.chaining };
  const override = role && raw.byRole ? raw.byRole[role] : undefined;
  const merged = override ? { ...base, ...override } : base;
  if (!merged.when && !merged.notWhen && !merged.chaining) return null;
  return merged;
}
