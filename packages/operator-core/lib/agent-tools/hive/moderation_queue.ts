/**
 * hive:moderation_queue — the OWNER's moderation queue: list reports filed by members
 * (Brief EN-3 / P-MOD). Read-only; resolve with hive:moderation_resolve, act with
 * hive:takedown / hive:ban_member.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { listReports } from '../../hive-reports-store';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'hive:moderation_queue',
  profile: 'engineer',
  description:
    "The owner's moderation queue — list member-filed reports for a Hive (default the open ones). Read-only. Act on a report with hive:moderation_resolve (action/dismiss), hive:takedown (hide content), or hive:ban_member.",
  guidance: {
    when: 'You (the owner) want to review reports members filed via hive:report.',
    notWhen: 'Filing a report (that is hive:report, member-side).',
    chaining: 'hive:moderation_queue → hive:takedown / hive:ban_member / hive:moderation_resolve.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    hive: z.string().min(1).max(120).describe("The Hive's home harness slug."),
    status: z
      .enum(['open', 'actioned', 'dismissed', 'all'])
      .optional()
      .describe("Filter by status (default 'open' — the live queue). 'all' = full history."),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId =
      args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const status = args.status === 'all' ? null : args.status;
    const rows = await listReports(workspaceId, args.hive, { status });
    return text({ ok: true, hive: args.hive, count: rows.length, reports: rows });
  },
});
