/**
 * plan_items:assign — push-assign a plan item to a stable agent-NAME (D-002/D-005).
 *
 * Intra-user push only: you assign to a name YOU own (your tokens). Assigning to a
 * fresh name claims it for you; assigning to a name owned by ANOTHER user is refused
 * (cross-user is pull-only — they claim from the pool). The assignment is durable
 * (survives sleep/interrupt) and federates as content.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { bestEffortOwnerUser, agentNameOwner, registerAgentName } from '../../plan-items/agent-names';
import { assignItem } from '../../plan-items/assignments';

export default defineTool({
  name: 'plan_items:assign',
  description:
    'Push-assign a plan item (P-NNN) to a stable agent-NAME. Durable intent — survives interruption; the named agent reads it via plan_items:my_items and claims it. Intra-user only: you may assign to a name you own (a fresh name is claimed for you); a name owned by another user is refused (cross-user is pull-only).',
  guidance: {
    when: 'You are dividing your own plan work across your named agents — "builder-1 takes P-001..P-003".',
    notWhen: 'You want to start working on an item right now — that is plan_items:claim (the live grip). Handing work to another USER\'s agents — they pull it (you cannot push onto their machine).',
    chaining: 'plan_items:assign { harness, plan, item, assignee } → the named agent: plan_items:my_items → plan_items:claim.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    plan: z.string().min(1).describe('plan slug'),
    item: z.string().min(1).describe('plan-item id (P-NNN)'),
    assignee: z.string().min(1).max(80).describe('the agent-name to assign to'),
    harness: z.string().max(120).optional().describe('harness the plan lives in (default: papercup)'),
    strategy: z.string().max(200).optional().describe('optional execution-strategy/blueprint hint'),
    note: z.string().max(2000).optional(),
  }),
  async handler(args, ctx) {
    const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: args.harness });
    const ownerUser = bestEffortOwnerUser(ctx);
    const existingOwner = await agentNameOwner(workspaceId, args.assignee);
    if (existingOwner && existingOwner !== ownerUser) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              refused: `agent-name '${args.assignee}' is owned by another user — cross-user assignment is pull-only (D-005). They join the work-group and claim it.`,
            }),
          },
        ],
      };
    }
    if (!existingOwner) await registerAgentName(workspaceId, args.assignee, ownerUser);
    const assignment = await assignItem({
      workspaceId,
      harnessSlug,
      planSlug: args.plan,
      itemId: args.item,
      assigneeName: args.assignee,
      assignedByUser: ownerUser,
      strategy: args.strategy ?? null,
      note: args.note ?? null,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, assignment }) }] };
  },
});
