/**
 * List goals in the current workspace.
 */

import { z } from 'zod';
import { defineTool } from '../../define-tool';

export default defineTool({
  name: 'goals:list',
  capability: 'goals:read',
  args: z.object({
    detail: z.enum(['summary', 'full']).default('summary'),
    limit: z.number().int().positive().max(200).default(50),
  }),
  async handler(args, ctx) {
    const rows = await ctx.tx<Array<Record<string, unknown>>>`
      SELECT id, title, body, parent_id, budget_cents, created_at
        FROM harness_shared.goals
       ORDER BY created_at DESC
       LIMIT ${args.limit}
    `;
    if (args.detail === 'summary') {
      return { data: rows.map((r) => ({ id: r.id, title: r.title })) };
    }
    return { data: rows };
  },
});
