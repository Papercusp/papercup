/**
 * dev:audit — cross-workspace audit_log feed.
 *
 * Drives the /dev page Audit tab.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { auditFeed } from '@/lib/dev-data';

export default defineTool({
  name: 'dev:audit',
  description: 'Cross-workspace audit_log feed (last N hours).',
  capability: 'audit:read',
  requirePrincipal: false,
  roles: ['operator', 'architect', 'debugger'],
  args: z.object({
    workspaceIds: z.array(z.string()).nullable().optional(),
    hours: z.number().int().positive().max(720).optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const result = await auditFeed({
      workspaceIds: args.workspaceIds ?? null,
      hours: args.hours,
      limit: args.limit,
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            count: result.entries.length,
            entries: result.entries,
          }),
        },
      ],
    };
  },
});
