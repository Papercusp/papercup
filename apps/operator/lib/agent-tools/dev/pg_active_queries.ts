/**
 * dev:pg_active_queries — list active/idle pg connections + their queries.
 *
 * Mirrors Restart's `/active-queries` endpoint; oldest first so long-
 * running queries surface at the top.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { pgActiveQueries } from '@/lib/dev-data';

export default defineTool({
  name: 'dev:pg_active_queries',
  description: 'List current pg_stat_activity rows (pid, state, query, duration) for the operator database.',
  capability: 'intel:read',
  requirePrincipal: false,
  roles: ['operator', 'architect', 'debugger'],
  args: z.object({
    limit: z.number().int().positive().max(200).optional(),
  }),
  async handler(args) {
    const result = await pgActiveQueries(args.limit);
    return {
      content: [
        { type: 'text', text: JSON.stringify({ count: result.queries.length, queries: result.queries }) },
      ],
    };
  },
});
