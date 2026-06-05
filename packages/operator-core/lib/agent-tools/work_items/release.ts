/**
 * work_items:release — Claimable (D-003). Unassigns the work-item.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { releaseWorkItem } from '../../work-items';

export default defineTool({
  name: 'work_items:release',
  profile: 'engineer',
  description: 'Release a work-item (clear its assignee / taken_by) so another agent can pick it up.',
  guidance: {
    when: 'You claimed a work-item but are no longer working it.',
    chaining: 'work_items:claim → … → work_items:release.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    harness: z.string().max(80).optional(),
  }),
  async handler(args) {
    const workItem = await releaseWorkItem(args.id, { harness: args.harness });
    return { content: [{ type: 'text' as const, text: JSON.stringify(workItem ? { ok: true, workItem } : { ok: false, error: `work_item '${args.id}' not found` }) }] };
  },
});
