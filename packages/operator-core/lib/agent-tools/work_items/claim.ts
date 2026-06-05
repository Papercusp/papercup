/**
 * work_items:claim — Claimable (D-003). Assigns the work-item to an agent
 * (feature-family → taken_by; issue-family → assignee) and subscribes the claimer.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { claimWorkItem } from '../../work-items';

export default defineTool({
  name: 'work_items:claim',
  profile: 'engineer',
  description: 'Claim a work-item (assign it to yourself, or to `assignee`). Claiming a feature sets taken_by; an issue sets assignee.',
  guidance: {
    when: 'You are starting work on a work-item — claim it so peers do not duplicate.',
    chaining: 'work_items:list → work_items:claim → work_items:set_state → work_items:release/close.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    assignee: z.string().max(120).optional().describe('default: you'),
    harness: z.string().max(80).optional(),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const workItem = await claimWorkItem(args.id, args.assignee ?? ident.ownerId, { harness: args.harness });
    return { content: [{ type: 'text' as const, text: JSON.stringify(workItem ? { ok: true, workItem } : { ok: false, error: `work_item '${args.id}' not found` }) }] };
  },
});
