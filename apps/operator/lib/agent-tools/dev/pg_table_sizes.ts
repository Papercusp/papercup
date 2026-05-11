/**
 * dev:pg_table_sizes — per-table total + index size for a schema.
 * Defaults to harness_shared. Largest first.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { pgTableSizes } from '@/lib/dev-data';

export default defineTool({
  name: 'dev:pg_table_sizes',
  description: 'List tables in a pg schema with total size, index size, and estimated row count. Defaults to harness_shared.',
  capability: 'intel:read',
  requirePrincipal: false,
  roles: ['operator', 'architect', 'debugger'],
  args: z.object({
    schema: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const result = await pgTableSizes(args.schema, args.limit);
    return {
      content: [
        { type: 'text', text: JSON.stringify({ count: result.tables.length, tables: result.tables }) },
      ],
    };
  },
});
