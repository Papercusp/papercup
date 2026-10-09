import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { recordSlackBugClassification, SlackBugClassificationSchema } from '../../external-triggers/slack-bug-classification';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'slack:record-classification', needsWorkspaceTx: true, profile: 'engineer',
  capability: 'operator:write', requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description: 'Persist one bug, non-bug or needs-information verdict for the originating ordinary Slack message. First recorded verdict wins on retries. This records report classification, not reproduction or authority to fix.',
  guidance: {
    when: 'The Slack classifier template has read its event via triggers:read-payload. Pass that same planRunId.',
    notWhen: 'Arbitrary Slack messages, changing a recorded verdict, or recording reproduction evidence.',
    chaining: 'Record verdict; only a bug verdict may proceed to configured source-bound Asana filing.',
  },
  args: z.object({ planRunId: z.number().int().positive(), classification: SlackBugClassificationSchema }).strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('slack_classification_workspace_required');
    return { data: { ok: true, ...await recordSlackBugClassification(ctx.tx!, workspaceId, args.planRunId, args.classification) } };
  },
});
