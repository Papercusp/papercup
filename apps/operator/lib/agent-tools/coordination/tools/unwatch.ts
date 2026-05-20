/**
 * coord:unwatch — cancel a previously-registered watch by its msg_id.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { removeWatch } from '../subscriptions';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:unwatch',
  description: 'Cancel a watch by its msg_id (the value coord:watch returned).',
  guidance: {
    when: 'Your work in a region is done and you no longer want notifications.',
    notWhen: 'You only want notifications to stop temporarily — there is no pause/resume yet.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  roles: [...COORD_ROLES],
  args: z.object({
    msg_id: z.string().min(1),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    await removeWatch(identity, args.msg_id);
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true }) },
      ],
    };
  },
});
