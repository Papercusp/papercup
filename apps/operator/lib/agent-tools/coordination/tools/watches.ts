/**
 * coord:watches — list active watches (optionally filter by owner).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listWatches } from '../subscriptions';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:watches',
  description:
    'List active watches — every subscribe that has not been unsubscribed and has not expired. Optionally filter to one owner.',
  guidance: {
    when: '"Who is watching what?" — diagnostics; checking your own watches.',
    notWhen: 'Looking up by single msg_id — coord:watches + filter is fine at current volumes.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  roles: [...COORD_ROLES],
  args: z.object({
    owner: z.string().optional(),
  }),
  async handler(args) {
    const w = await listWatches({ owner: args.owner });
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ watches: w }) },
      ],
    };
  },
});
