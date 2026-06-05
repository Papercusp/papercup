/**
 * work_items:search — cross-kind full-text search over the unified surface
 * (parity with issues:search / features search). Searches both kind-tables and
 * merges the matches; filter by harness / kind.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { searchWorkItems, WORK_ITEM_KINDS, type WorkItemKind } from '../../work-items';

export default defineTool({
  name: 'work_items:search',
  profile: 'engineer',
  description: 'Full-text search work-items across kinds (feature/research-task/chunk/bug/change). Matches title + body/summary. Filter by harness or kind. Use to dedup before creating.',
  guidance: {
    when: 'You want to find existing work-items by free text (e.g. dedup before filing, or locate a known issue/feature).',
    chaining: 'work_items:search (dedup) → work_items:create, or → work_items:get { id } for detail.',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    query: z.string().min(1).max(400),
    harness: z.string().max(80).optional(),
    kind: z.enum([...WORK_ITEM_KINDS] as [string, ...string[]]).optional(),
    limit: z.number().int().positive().max(200).optional(),
  }),
  async handler(args) {
    const items = await searchWorkItems(args.query, {
      harness: args.harness,
      kind: args.kind as WorkItemKind | undefined,
      limit: args.limit,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, count: items.length, items }) }] };
  },
});
