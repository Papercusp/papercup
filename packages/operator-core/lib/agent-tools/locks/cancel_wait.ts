/**
 * locks:cancel_wait — abandon a queued waiter ticket.
 *
 * Phase 1: stub. Waiter tickets are created by the wait subsystem in
 * Phase 2; with no wait path, there's nothing to cancel. The tool is
 * registered so the surface is stable across phases.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { tryCancelWait } from './su-lock-store';

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
  name: 'locks:cancel_wait',
  description:
    'Abandon a queued waiter ticket. Returns cancelled=true if the wait was active; cancelled=false means a grant raced (you now hold a lock you didn\'t want — call locks:release immediately).',
  guidance: {
    when: 'Mid-wait, when the user redirects you to other work or you decide a different approach.',
    notWhen: 'After you\'ve already received an ok response from locks:acquire — there\'s no waiter to cancel.',
    chaining: 'On cancelled=false → locks:release { all_mine: true } to free the lock you got handed.',
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    ticket_id: z.string().uuid(),
  }),
  async handler(args, ctx) {
    const { ownerId, coordinationDomain } = readIdentity(ctx);
    const result = await inWorkspaceTxn(coordinationDomain, ownerId, async (tx) =>
      tryCancelWait(tx, args.ticket_id, ownerId),
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, cancelled: result.cancelled }),
        },
      ],
    };
  },
});
