/**
 * work_items:list — cross-kind list over the unified surface (unify-work-items,
 * D-007). Default = top-level items only; chunks surface under their parent (D-004,
 * pass `parent` or includeChildren). Filter by harness / kind / state.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { listWorkItems, WORK_ITEM_KINDS, type WorkItemKind } from '../../work-items';

export default defineTool({
  name: 'work_items:list',
  profile: 'engineer',
  description: 'List work-items across kinds (feature/research-task/chunk/bug/change). Default shows top-level items (chunks are hidden — pass parent or includeChildren). Filter by harness, kind, state.',
  guidance: {
    when: 'You want the current work-items in a harness (or operator-wide). Default hides chunks; pass `parent` to see a parent\'s chunks.',
    chaining: 'work_items:list → work_items:get { id } for detail; work_items:claim to take one.',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().max(80).optional(),
    kind: z.enum([...WORK_ITEM_KINDS] as [string, ...string[]]).optional(),
    state: z.string().max(40).optional(),
    parent: z.string().max(80).optional().describe('list children (chunks) of this parent id'),
    includeChildren: z.boolean().optional().describe('include child items (chunks) in the list'),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const items = await listWorkItems({
      harness: args.harness,
      kind: args.kind as WorkItemKind | undefined,
      state: args.state,
      parent: args.parent,
      includeChildren: args.includeChildren,
      limit: args.limit,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, count: items.length, items }) }] };
  },
});
