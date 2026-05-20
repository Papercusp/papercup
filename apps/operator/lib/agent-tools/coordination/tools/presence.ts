/**
 * coord:presence — list active coordination agents and what they are
 * doing right now.
 *
 * Joins the live liveness layer (harness_shared.coord_presence) with
 * the durable record (harness_shared.power_user_sessions). Sessions
 * whose heartbeat is older than 10 min are returned in `stale`, not
 * `active`. agent-coordination-architecture-v2 §4.2 / §4.3.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listPresence } from '../presence';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:presence',
  description:
    'List coordination agents and their declared intent. `active` are sessions with a fresh heartbeat; `stale` heartbeat is >10 min old (the session has almost certainly ended). Optionally filter by workspace.',
  guidance: {
    when: '"Who else is working right now, and on what?" — before starting work that might overlap.',
    notWhen: 'Checking whether a specific file is free — use locks:queue for that.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  roles: [...COORD_ROLES],
  args: z.object({
    workspace: z
      .string()
      .optional()
      .describe('Filter to one workspace id; omit to list all.'),
  }),
  async handler(args) {
    const records = await listPresence({ workspaceId: args.workspace ?? null });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            active: records.filter((r) => !r.stale),
            stale: records.filter((r) => r.stale),
          }),
        },
      ],
    };
  },
});
