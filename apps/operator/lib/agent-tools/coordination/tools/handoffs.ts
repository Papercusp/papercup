/**
 * coord:handoffs — list handoff records (with acceptance status).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listHandoffs } from '../handoffs';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:handoffs',
  description:
    'List handoff records, each annotated with its acceptance file if one exists. Optional `status` filters to open (no acceptance) or accepted.',
  guidance: {
    when: 'Diagnostics — "who handed what to whom?" or "what handoffs to me are still open?".',
    notWhen: 'A single known msg_id — there is no read-by-id tool yet; the listing is small.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    status: z.enum(['open', 'accepted']).optional(),
  }),
  async handler(args) {
    const out = await listHandoffs({ status: args.status });
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ handoffs: out }) },
      ],
    };
  },
});
