/**
 * Public agent-review door over the existing work-item + Blender lifecycle.
 *
 * Identity is always caller-derived. Review pickup requires one concrete harness
 * and cannot select the submitter's own row; resubmission is accepted only from
 * the original submittedBy owner in the lifecycle core.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { claimNextAgentReview, resubmitAgentReview } from '../../harness/improvements/agent-review';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { harnessRequiredResult, resolveConcreteHarnessSlug } from '../_harness-scope';

export default defineTool({
  name: 'improvements:agent-review',
  profile: 'engineer',
  description:
    'Claim the next peer-review item in one concrete harness, or resubmit your own revision-requested item. Review grades still go through blender:grade-idea; this door only owns reviewer pickup and submitter resubmission.',
  guidance: {
    when: "Use mode:'claim-next' to take a pending change/feature for peer review, then grade its routed idea with blender:grade-idea. Use mode:'resubmit' after addressing the review feedback on your own revision-requested item.",
    notWhen:
      'Do not use this to grade or approve — blender:grade-idea is the sole grade authority. Do not use ordinary scheduler:get_next for pending review work; that lane excludes it until approval.',
    chaining:
      "improvements:agent-review { mode:'claim-next', harness? } → inspect the work item → blender:grade-idea { routedRef:'wi:<id>', grade, feedback? }; revision author fixes → improvements:agent-review { mode:'resubmit', id }.",
    seeAlso: [
      'blender:grade-idea (record the peer grade and drive approval/revision)',
      'work_items:get (read the claimed work and its checkpoint)',
      'work_items:comment (record review-relevant progress)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('claim-next'),
      harness: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "Harness to review. Omit only when the session is already scoped to one concrete harness; 'all' and '*' are refused.",
        ),
    }),
    z.object({
      mode: z.literal('resubmit'),
      id: z.string().min(1).max(80).describe('Your revision-requested work-item id.'),
    }),
  ]),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    if (args.mode === 'claim-next') {
      const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
      if (!harnessSlug) return harnessRequiredResult('improvements:agent-review');
      const workItem = await claimNextAgentReview({ reviewer: identity.ownerId, harnessSlug });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'claim-next',
              claimed: workItem !== null,
              workItem,
            }),
          },
        ],
      };
    }

    const result = await resubmitAgentReview({ id: args.id, submittedBy: identity.ownerId });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, mode: 'resubmit', ...result }),
        },
      ],
    };
  },
});
