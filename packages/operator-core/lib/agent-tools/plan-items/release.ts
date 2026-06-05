/**
 * plan_items:release — drop the live claim on a plan item (keeps the assignment).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { getClaim, releaseClaim } from '../../plan-items/claims';

export default defineTool({
  name: 'plan_items:release',
  description:
    'Drop your live claim on a plan item so it returns to your assignee status (if assigned) or the pool (if pulled). Does NOT clear the assignment — the item stays yours by name; you just stop holding it. claim_id is optional (resolved from your current claim).',
  guidance: {
    when: 'You finished (or are pausing) work on an item you claimed and want to free the live grip.',
    notWhen: 'You want to give up the item entirely — also plan_items:unassign it.',
    chaining: 'plan_items:claim → … → plan_items:release { harness, plan, item }.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    plan: z.string().min(1).describe('plan slug'),
    item: z.string().min(1).describe('plan-item id (P-NNN)'),
    harness: z.string().max(120).optional().describe('harness the plan lives in (default: papercup)'),
    claim_id: z.string().uuid().optional().describe('the claim_id from plan_items:claim (default: your current claim on the item)'),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: args.harness });
    let claimId = args.claim_id;
    if (!claimId) {
      const current = await getClaim(workspaceId, harnessSlug, args.plan, args.item);
      if (!current || current.owner !== id.ownerId) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, released: false, note: 'you hold no claim on this item' }) }] };
      }
      claimId = current.claimId;
    }
    const released = await releaseClaim(workspaceId, harnessSlug, args.plan, args.item, claimId, id.ownerId);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, released }) }] };
  },
});
