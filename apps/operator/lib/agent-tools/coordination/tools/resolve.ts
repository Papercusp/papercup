/**
 * coord:resolve — record the human's choice on an escalation.
 *
 * Read-modify-writes the per-event file in place. Idempotent on a
 * resolved escalation (returns already_resolved).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { resolveEscalation } from '../escalations';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:resolve',
  description:
    'Resolve an escalation by msg_id. Records the chosen option id (or arbitrary string) and optional note on the escalation file in place.',
  guidance: {
    when: 'The human (or an authorised agent acting on their behalf) has decided how to proceed on an open escalation.',
    notWhen: 'Acknowledging without deciding — use coord:ack. The escalation file is the human-resolution surface.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  roles: [...COORD_ROLES],
  args: z.object({
    msg_id: z.string().min(1),
    choice: z.string().min(1),
    note: z.string().optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const out = await resolveEscalation({
      msg_id: args.msg_id,
      choice: args.choice,
      note: args.note,
      resolver: identity.ownerId,
    });
    if (out === 'not_found') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'not_found',
              detail: `no escalation with msg_id=${args.msg_id}`,
            }),
          },
        ],
        isError: true,
      };
    }
    if (out === 'already_resolved') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'already_resolved',
              detail: `escalation msg_id=${args.msg_id} already has a resolution`,
            }),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, escalation: out }),
        },
      ],
    };
  },
});
