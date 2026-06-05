/**
 * coord:thread — read every coord entry connected via `related_msg_id`
 * to a given root, in time order.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readThread } from '../messages';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:thread',
  description:
    'Reconstruct a coord thread rooted at `root_msg_id` — every entry connected via the `related_msg_id` chain, sorted by ts ascending.',
  guidance: {
    when: 'You want the full conversation around a coord message (replies, acks, resolutions).',
    notWhen: 'For a fresh inbox sweep — use coord:inbox.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    root_msg_id: z.string().min(1),
  }),
  async handler(args) {
    const entries = await readThread(args.root_msg_id);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ root: args.root_msg_id, entries }),
        },
      ],
    };
  },
});
