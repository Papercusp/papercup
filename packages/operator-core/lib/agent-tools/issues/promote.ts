/**
 * issues:promote — mint an F-FIX feature from an issue so the harness pipeline
 * fixes it (engineer-issues-2026-06-03, Phase 4). Reuses the pipeline's
 * mintFixFeatureRow; records the linked feature on the issue.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { promoteIssue } from '../../issues-engineer';

export default defineTool({
  name: 'issues:promote',
  profile: 'engineer',
  description:
    'Promote an issue into an F-FIX feature so the harness pipeline fixes it. A harness-scoped issue mints into its harness; an operator-scope issue needs a target harness. Records the linked feature; the issue stays open until the fix lands.',
  guidance: {
    when: 'An issue is a real defect that should be FIXED by the pipeline (not just tracked or answered) — promote it to mint + link the fix feature.',
    notWhen: 'A question/discussion (resolve it), a nit you would not spend a feature on, or an issue already linked to a feature.',
    chaining: 'issues:get → issues:promote { harness } → the F-FIX feature dispatches in that harness; issues:close when it lands.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    harness: z.string().optional().describe('target harness slug — required for operator-scope issues'),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const res = await promoteIssue(args.id, { harness: args.harness, actor: id.ownerId });
    if ('error' in res) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: res.error }) }] };
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, issue: { id: res.issue.id, linkedFeatureId: res.issue.linkedFeatureId }, feature: res.feature }),
        },
      ],
    };
  },
});
