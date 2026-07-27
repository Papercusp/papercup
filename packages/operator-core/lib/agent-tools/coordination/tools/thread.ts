/**
 * coord:thread — read every coord entry connected via `related_msg_id`
 * to a given root, in time order.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readThread } from '../messages';
import { projectAuthoredFields } from '../message-fields';
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
    // P-033 (e): same reason as coord:read — the authored structure rides `extra`
    // and the rendered `body` is a flattened projection of it. A thread is where a
    // disagreement gets re-read, so it is the surface where "what did the sender say
    // this rested on" matters most. Attached per entry; absent when nothing authored.
    const withAuthored = entries.map((entry) => {
      const authored = projectAuthoredFields((entry as { extra?: unknown }).extra);
      return authored ? { ...entry, authored } : entry;
    });
    return { data: { root: args.root_msg_id, entries: withAuthored } };
  },
});
