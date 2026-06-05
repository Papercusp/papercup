/**
 * plan_items:my_items — the items assigned to my adopted agent-NAME, with state.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { requireActingName } from '../../plan-items/agent-names';
import { myItemsWithState } from '../../plan-items/liveness';

export default defineTool({
  name: 'plan_items:my_items',
  description:
    'List the plan items assigned to your agent-NAME (across all plans), each with its live claim state (active / assigned-idle). "Go to your items" resolves here. Adopt a name first (plan_items:adopt_name) or pass agent_name explicitly.',
  guidance: {
    when: 'You were told to work on your assigned items — read them here, then claim the next idle one.',
    notWhen: 'You want unassigned pool items — those are not "yours"; see plan_items:status for the pool.',
    chaining: 'plan_items:adopt_name → plan_items:my_items → plan_items:claim { the next assigned-idle item }.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    agent_name: z.string().max(80).optional().describe('act as this name (default: the session\'s adopted name)'),
    harness: z.string().max(120).optional().describe('workspace scope (default: papercup)'),
  }),
  async handler(args, ctx) {
    const { workspaceId } = await resolvePlanScope({ harnessSlug: args.harness });
    const name = await requireActingName(ctx, workspaceId, args.agent_name);
    const items = await myItemsWithState(workspaceId, name);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, agent_name: name, count: items.length, items }) }],
    };
  },
});
