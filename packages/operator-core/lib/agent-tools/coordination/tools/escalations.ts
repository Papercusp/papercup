/**
 * coord:escalations — list open / resolved escalation records.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listEscalationsPaginated } from '../escalations';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:escalations',
  description:
    'List escalations addressed to the human (paginated to prevent unbounded responses). Default: all. Filter by status=open (resolved is null) or status=resolved (resolved is set). Pass maxRecords to control page size (default 1000).',
  guidance: {
    when: 'Showing the human inbox; diagnostics; checking your own past escalations.',
    notWhen: 'A specific msg_id you already have — there is no escalation read-by-id tool yet; coord:escalations + filter is enough at current volumes.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    status: z.enum(['open', 'resolved']).optional(),
    maxRecords: z.number().int().min(1).max(5000).optional().describe('Max records to return per call (default 1000, max 5000)'),
  }),
  async handler(args) {
    const result = await listEscalationsPaginated({ 
      status: args.status,
      maxRecords: args.maxRecords,
    });
    
    return {
      content: [
        { 
          type: 'text' as const, 
          text: JSON.stringify({ 
            escalations: result.escalations,
            count: result.escalations.length,
            total: result.total,
            truncated: result.truncated,
            note: result.truncated ? `Showing ${result.escalations.length} of ${result.total} escalations. Call again to fetch more or increase maxRecords.` : undefined,
          }),
        },
      ],
    };
  },
});
