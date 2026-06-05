/**
 * coord:escalations — list open / resolved escalation records.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listEscalations } from '../escalations';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:escalations',
  description:
    'List escalations addressed to the human. Default: all. Filter by status=open (resolved is null) or status=resolved (resolved is set).',
  guidance: {
    when: 'Showing the human inbox; diagnostics; checking your own past escalations.',
    notWhen: 'A specific msg_id you already have — there is no escalation read-by-id tool yet; coord:escalations + filter is enough at current volumes.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    status: z.enum(['open', 'resolved']).optional(),
  }),
  async handler(args) {
    const escs = await listEscalations({ status: args.status });
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ escalations: escs }) },
      ],
    };
  },
});
