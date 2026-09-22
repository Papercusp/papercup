/** Resolve a hook-captured pending owner turn (promote or dismiss). */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { dismissOwnerDirective, promoteOwnerDirective } from '../../owner-directives';
import { clearDirectiveFromAgenda, directiveActionVerdict } from '../../owner-directive-agenda';
import { activeWorkspaceId } from '../../workspace-registry';

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
    action: z.enum(['promote', 'dismiss', 'clear']).describe("promote = confirm this really is a directive from the owner; affects everyone. dismiss = it is not a directive at all; affects everyone. clear = remove it from YOUR OWN banner only, changing nothing for anyone else — the right action for a directive addressed to another session."),
    reason: z.string().min(4).max(2000).optional().describe('Required when action=dismiss or clear; optional when action=promote, where it is stored as the promotion note.'),
  }),
  async handler(args, ctx) {
    if (args.action !== 'promote' && !args.reason?.trim()) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'reason_required' }) }], isError: true };
    }
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = activeWorkspaceId();

    // AGENDA-CLEARING — deliberately UNGUARDED. Clearing a foreign directive
    // from your own banner is the correct operation, and refusing it is what
    // would strand every foreign row in every agent's Orientation forever
    // (D-008, defect B). It must never acquire an ownership check.
    if (args.action === 'clear') {
      const cleared = await clearDirectiveFromAgenda(
        { directiveId: args.id, ownerId: identity.ownerId, workspaceId, reason: args.reason!.trim() },
        undefined,
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...cleared, scope: 'this-session-only' }) }] };
    }

    // ACTION — guarded. promote/dismiss assert something about the OWNER'S
    // ORDER (that it is genuine, or that it is not a directive at all), which
    // only the addressed session or a holder of linking work may truthfully do.
    const verdict = await directiveActionVerdict(
      { directiveId: args.id, ownerId: identity.ownerId, workspaceId },
      undefined,
    );
    if ('notFound' in verdict) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'not_found' }) }], isError: true };
    }
    if (!verdict.allowed) {
      // The refusal REDIRECTS rather than dead-ends: naming `clear` is what
      // keeps this guard from becoming the strand it was designed to avoid.
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          ok: false,
          error: 'foreign_directive',
          addressedTo: verdict.addressedTo,
          holders: verdict.holders,
          hint: `Directive #${args.id} was addressed to ${verdict.addressedTo}${verdict.holders.length ? ` and is held by ${verdict.holders.join(', ')}` : ''}. ${args.action === 'dismiss' ? 'Dismissing it would remove it from THEIR agenda too' : 'Promoting it asserts a claim about their owner order'}. To take it off your OWN banner without affecting them, use action:'clear'.`,
        }) }],
        isError: true,
      };
    }

    const result = args.action === 'promote'
      ? await promoteOwnerDirective({ id: args.id, promotedBy: identity.ownerId, note: args.reason ?? null })
      : await dismissOwnerDirective({ id: args.id, reason: args.reason!.trim(), dismissedBy: identity.ownerId });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      ...(result.ok ? {} : { isError: true }),
    };
  },
});
