/**
 * coord:ack — acknowledge a coord message you received.
 *
 * The ack is appended to the acker's OWN outbox (preserving the
 * one-writer-per-file invariant) with `related_msg_id` pointing at
 * the original. The sender sees it as a fresh inbox entry on their
 * next coord:inbox.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { appendAck, readThread } from '../messages';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:ack',
  description:
    'Acknowledge a coord message by its msg_id. Posts a `kind: "ack"` entry in your outbox addressed back at the original sender, so they can see you received it.',
  guidance: {
    when: 'After acting on (or deliberately not acting on) a coord message — closes the loop for the sender.',
    notWhen: 'For routine read-and-forget. Acks are most useful for hand-offs and questions where the sender is waiting.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    msg_id: z.string().min(1),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Find the original message (across all outboxes) so we can address
    // the ack back at its sender. Uses readThread — slightly wider than
    // needed but it's a single scan over a small directory.
    const thread = await readThread(args.msg_id);
    const target = thread.find((m) => m.msg_id === args.msg_id);
    if (!target) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'unknown_msg_id',
              detail: `no coord message with msg_id=${args.msg_id}`,
            }),
          },
        ],
        isError: true,
      };
    }
    const env = await appendAck(identity, args.msg_id, target.from);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            ack_msg_id: env.msg_id,
            acked: target.msg_id,
            acked_from: target.from,
          }),
        },
      ],
    };
  },
});
