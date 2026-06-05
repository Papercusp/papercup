/**
 * work_items:get — resolve one work-item by id across kinds (unify-work-items).
 * Searches both kind-tables (ids are disjoint across families). Returns the
 * unified work-item shape incl. kind, lifecycle state, assignee, parent.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { getWorkItem, getWorkItemDetail } from '../../work-items';

export default defineTool({
  name: 'work_items:get',
  profile: 'engineer',
  description: 'Fetch one work-item by id (WI-/F-/EI-…) across every kind. Pass `harness` to disambiguate a feature id that may repeat across harnesses.',
  guidance: {
    when: 'You have a work-item id and need its full state (kind, lifecycle, assignee, parent).',
    chaining: 'work_items:list → work_items:get { id } for detail.',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    harness: z.string().max(80).optional(),
    detail: z.boolean().optional().describe('also return topics, thread posts (comments), and outgoing links'),
  }),
  async handler(args) {
    const workItem = args.detail ? await getWorkItemDetail(args.id, args.harness) : await getWorkItem(args.id, args.harness);
    return { content: [{ type: 'text' as const, text: JSON.stringify(workItem ? { ok: true, workItem } : { ok: false, error: `work_item '${args.id}' not found` }) }] };
  },
});
