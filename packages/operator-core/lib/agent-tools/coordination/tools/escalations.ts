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
    'List escalations addressed to the human — NEWEST-FIRST and bounded at the storage layer (EI-1548: never loads the whole backlog into memory). Default page 50, max 500. Filter by status=open / status=resolved. `truncated:true` means older escalations exist beyond the window — raise maxRecords or narrow by status.',
  guidance: {
    when: 'Showing the human inbox; diagnostics; checking your own past escalations.',
    notWhen: 'A specific msg_id you already have — there is no escalation read-by-id tool yet; coord:escalations + filter is enough at current volumes.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    status: z.enum(['open', 'resolved']).optional(),
    maxRecords: z.number().int().min(1).max(500).optional().describe('Max records per call (default 50, max 500)'),
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
            note: result.truncated ? `Bounded to the ${result.total} most-recent escalation events (older exist beyond this window). Raise maxRecords (max 500) or filter by status to page further.` : undefined,
          }),
        },
      ],
    };
  },
});
