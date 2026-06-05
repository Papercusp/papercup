/**
 * work_items:set_state — Lifecycle (D-003). Sets the kind-specific lifecycle state
 * (feature-family → status e.g. todo|in_progress|passed|failing; issue-family →
 * open|resolved|closed). Dispatches to the right kind-table.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { setWorkItemState } from '../../work-items';

export default defineTool({
  name: 'work_items:set_state',
  profile: 'engineer',
  description: 'Set a work-item\'s lifecycle state. feature-family: a feature status (todo|in_progress|passed|failing|deprecated…). issue-family: open|resolved|closed.',
  guidance: {
    when: 'You moved a work-item along its lifecycle (started, resolved, etc.).',
    chaining: 'work_items:claim → … → work_items:set_state { state }.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    state: z.string().min(1).max(40),
    harness: z.string().max(80).optional(),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const workItem = await setWorkItemState(args.id, args.state, { harness: args.harness, by: ident.ownerId });
    return { content: [{ type: 'text' as const, text: JSON.stringify(workItem ? { ok: true, workItem } : { ok: false, error: `work_item '${args.id}' not found` }) }] };
  },
});
