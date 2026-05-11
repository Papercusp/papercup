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
    'List MCP-exposed tools with permission status for the caller. Each entry includes name, description, capability, roles allowlist, and an `allowed` flag with `reason` when blocked. Use to discover what you can call without trial-and-error.',
  capability: 'agent_tools:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    /** Optional substring/regex match on tool name. */
    filter: z.string().optional(),
    /** Limit; default 250. */
    limit: z.number().int().positive().max(500).optional(),
    /** Set false to also include tools the caller cannot invoke. Default true. */
    onlyAllowed: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const role = ctx.role;
    const isSuperuser = ctx.isSuperuser === true;
    const principalCaps = ctx.principal?.capabilities ?? new Set<string>();

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
    }> = [];

    for (const tool of listAllProjectedTools()) {
      if (!tool.expose.mcp) continue;
      const name = tool.expose.mcp.name;
      if (filterRe && !filterRe.test(name)) continue;

      let allowed = true;
      let reason: string | null = null;

      // Role allowlist (skipped in superuser mode).
      if (!isSuperuser && tool.roles && role && !tool.roles.includes(role)) {
        allowed = false;
        reason = `role_not_allowed: tool requires one of [${tool.roles.join(', ')}], caller is "${role}"`;
      }

      // Capability gate — only meaningful when a principal is attached
      // (i.e., the bearer resolved). For role-tools with no principal,
      // the dispatcher skips this gate, so we mirror that.
      if (allowed && ctx.principal && tool.capabilities.length > 0) {
        const missing = tool.capabilities.filter((c) => !principalCaps.has(c));
        if (missing.length > 0) {
          allowed = false;
          reason = `missing_capability: principal lacks [${missing.join(', ')}]`;
        }
      }

      if (onlyAllowed && !allowed) continue;

      out.push({
        name,
        description: tool.description,
        capability: tool.capabilities[0] ?? null,
        roles: tool.roles ?? null,
        // tier is on the legacy ToolDefinition; ProjectedTool doesn't carry it
        // — leave null for now, callers can grep the manifest if they care.
        tier: null,
        timeoutSec: tool.timeoutSec ?? null,
        rolesQuota: (tool.rolesQuota as Record<string, unknown> | undefined) ?? null,
        allowed,
        reason,
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
