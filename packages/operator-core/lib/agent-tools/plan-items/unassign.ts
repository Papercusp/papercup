/**
 * plan_items:unassign — release a plan-item assignment (soft, federated).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { unassignItem } from '../../plan-items/assignments';

export default defineTool({
  name: 'plan_items:unassign',
  description:
    'Release a plan item\'s assignment so it returns to the unassigned pool. The item\'s history persists (soft-release). Does NOT drop a live claim — release that with plan_items:release.',
  guidance: {
    when: 'An assignment is no longer wanted — reassigning to nobody, or freeing an item back to the pool.',
    notWhen: 'You just want to stop actively working but keep the item assigned to you — that is plan_items:release (drops the live claim, keeps the assignment).',
    chaining: 'plan_items:status to see assignments → plan_items:unassign { harness, plan, item }.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    plan: z.string().min(1).describe('plan slug'),
    item: z.string().min(1).describe('plan-item id (P-NNN)'),
    harness: z.string().max(120).optional().describe('harness the plan lives in (default: papercup)'),
  }),
  async handler(args, _ctx) {
    const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: args.harness });
    const released = await unassignItem(workspaceId, harnessSlug, args.plan, args.item);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            released ? { ok: true, released } : { ok: true, released: null, note: 'no active assignment' },
          ),
        },
      ],
    };
  },
});
