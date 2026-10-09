import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { fileSlackBugInAsana } from '../../external-triggers/slack-asana-filing';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'slack:file-asana-bug', needsWorkspaceTx: false, profile: 'engineer',
  capability: 'operator:write', requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description: 'File the durable bug verdict from a Slack classifier run in its configured Asana destination. Accepts only planRunId; pins source and correlation before HTTP. Replays recover an existing task and never repeat an uncertain create.',
  guidance: {
    when: 'After slack:record-classification returned a bug verdict, with the same planRunId.',
    notWhen: 'Arbitrary task creation, non-bugs or choosing a destination from message text.',
    chaining: 'Retain externalRef as proof; pendingReconciliation is incomplete and requires recovery with the same run.',
  },
  args: z.object({ planRunId: z.number().int().positive() }).strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('slack_asana_workspace_required');
    return { data: { ok: true, ...await fileSlackBugInAsana(getOrgPg().sql, workspaceId, args.planRunId) } };
  },
});
