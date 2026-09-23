import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { checkAcceptanceBarApproverEligibility } from '../../rubrics';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';

const argsSchema = z.object({
  rubricRef: z.string().trim().min(1).max(200).describe('the started acceptance rubric ref'),
  ownerId: z.string().trim().min(1).max(200).describe('the prospective reviewer identity to screen'),
  applierId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('the identity that will apply the amendment, when known'),
});

function normalizeRubricRef(ref: string): string {
  const typed = /^plan:(.+)$/i.exec(ref.trim());
  return typed?.[1]?.trim() || ref.trim();
}

export default defineTool({
  name: 'rubrics:check-approver',
  profile: 'engineer',
  description:
    'Read-only pre-dispatch lineage screen for a prospective reviewer of a started acceptance BAR amendment. This reports eligibility only; it does not approve, authorize, or apply an amendment.',
  guidance: {
    when: 'Before routing an outside-lineage reviewer for a started acceptance BAR amendment, when the candidate ownerId is known.',
    notWhen:
      'Do not treat an eligible result as approval. The reviewer must still inspect the full candidate criteria and fresh dry-run diff on a durable thread; the apply guard remains authoritative.',
    chaining:
      "rubrics:check-approver { rubricRef, ownerId } → route only eligible candidates → post the exact candidate criteria and fresh rubrics:amend dryRun diff for the reviewer to inspect → collect the approval receipt → apply with rubrics:amend.",
    seeAlso: ['rubrics:amend (preview and apply the exact amendment)', 'rubrics:get (read the full rubric criteria)'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: argsSchema,
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    return runWithWorkspaceIfConcrete(identity.workspaceId ?? undefined, async () => {
      const result = await checkAcceptanceBarApproverEligibility({
        rubricId: normalizeRubricRef(args.rubricRef),
        ownerId: args.ownerId,
        ...(args.applierId ? { applierId: args.applierId } : {}),
      });
      return { data: { ok: true, rubricRef: args.rubricRef, ...result } };
    });
  },
});
