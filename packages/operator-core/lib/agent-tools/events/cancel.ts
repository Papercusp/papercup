/**
 * events:cancel — retract one of YOUR active awaits
 * (await-event-primitive-2026-06-05 P-003).
 *
 * Subscriber-scoped: you can only cancel your own (the store matches
 * subscriber_id; a peer's await is their wait, not yours to kill).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { cancelAwait } from '../../events/await/store';

const SU_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

export default defineTool({
  name: 'events:cancel',
  description: 'Cancel one of your active events:await registrations by await_id (you will not be woken).',
  guidance: {
    when: 'The thing you were waiting on no longer matters — you pivoted, the work resolved another way, or you are wrapping up the session and the wake would be a wasted turn.',
    notWhen: 'A fired await needs no cancel (one-shot — it already cleared). You cannot cancel a peer’s await.',
    chaining: 'events:status to find the await_id → events:cancel { await_id }.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    await_id: z.number().int().positive().describe('The id events:await returned.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const cancelled = await cancelAwait({
      awaitId: args.await_id,
      subscriberId: identity.ownerId,
      workspaceId: identity.workspaceId ?? undefined,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            cancelled
              ? { ok: true, await_id: args.await_id, cancelled: true }
              : { ok: false, reason: 'not_found_or_not_yours_or_already_settled', await_id: args.await_id },
          ),
        },
      ],
    };
  },
});
