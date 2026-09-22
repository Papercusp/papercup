/** Resolve a hook-captured pending owner turn (promote or dismiss). */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { dismissOwnerDirective, promoteOwnerDirective } from '../../owner-directives';

export default defineTool({
  name: 'orders:resolve-pending',
  profile: 'engineer',
  description:
    'Resolve one UserPromptSubmit-captured owner turn: promote it to an actionable open directive, or dismiss it with a mandatory reason.',
  guidance: {
    when: 'The Orientation block shows a PENDING owner directive. Resolve every pending row on the next agent turn before starting new work.',
    notWhen: 'Closing an already-promoted directive — use orders:disposition.',
    seeAlso: ['orders:record', 'orders:disposition', 'orders:list'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.number().int().positive().describe('Pending directive id from the Orientation block or orders:list.'),
    action: z.enum(['promote', 'dismiss']).describe('Promote to open, or dismiss with a reason.'),
    reason: z.string().min(4).max(2000).optional().describe('Required when action=dismiss (why this turn is not an owner directive); optional when action=promote, where it is stored as the promotion note.'),
  }),
  async handler(args, ctx) {
    if (args.action === 'dismiss' && !args.reason?.trim()) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'reason_required' }) }], isError: true };
    }
    const identity = resolveAgentIdentity(ctx);
    const result = args.action === 'promote'
      ? await promoteOwnerDirective({ id: args.id, promotedBy: identity.ownerId, note: args.reason ?? null })
      : await dismissOwnerDirective({ id: args.id, reason: args.reason!.trim(), dismissedBy: identity.ownerId });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      ...(result.ok ? {} : { isError: true }),
    };
  },
});
