/**
 * hive:moderation_resolve — OWNER resolves a report (action it / dismiss it)
 * (Brief EN-3 / P-MOD). The resolution federates back to the reporter. This only
 * changes the report's STATUS; the actual content-hide / member-ban are separate
 * owner actions (hive:takedown / hive:ban_member).
 *
 * AUTHORITY: the owning Swarm (holds the Hive key).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { loadHivePubkey } from '../../identity/hive-keypair';
import { setReportStatus } from '../../hive-reports-store';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'hive:moderation_resolve',
  profile: 'engineer',
  description:
    "OWNER resolves a moderation report: 'actioned' (you took action — e.g. a takedown/ban) or 'dismissed' (no action). Federates the resolution back. Requires holding the Hive key. Does NOT itself hide content or ban — use hive:takedown / hive:ban_member for that.",
  guidance: {
    when: 'You reviewed a report (hive:moderation_queue) and want to mark it resolved.',
    notWhen: 'You want to actually hide content (hive:takedown) or ban a member (hive:ban_member) — do that first, then resolve.',
    chaining: 'hive:moderation_queue → (hive:takedown / hive:ban_member) → hive:moderation_resolve.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger'],
  args: z.object({
    hive: z.string().min(1).max(120).describe("The Hive's home harness slug."),
    reportId: z.string().min(1).max(200).describe('The report id (from hive:moderation_queue).'),
    status: z.enum(['actioned', 'dismissed']).describe("'actioned' = you took action; 'dismissed' = no action."),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId =
      args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const ownerPubkey = await loadHivePubkey(workspaceId, args.hive).catch(() => null);
    if (!ownerPubkey) {
      return text({ ok: false, code: 'not_owner', detail: 'this Swarm does not hold the Hive private key' });
    }
    const report = await setReportStatus(workspaceId, args.hive, args.reportId, args.status);
    if (!report) return text({ ok: false, code: 'no_report', detail: 'no report with that id' });
    return text({ ok: true, report });
  },
});
