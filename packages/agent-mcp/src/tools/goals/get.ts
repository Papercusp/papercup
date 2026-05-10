/**
 * Get a single goal by id. Returns lineage (children + descendant tasks)
 * when detail='full'.
 */

import { z } from 'zod';
import { defineTool } from '../../define-tool';

export default defineTool({
  name: 'goals:get',
  capability: 'goals:read',
  args: z.object({
    id: z.string().min(1),
    detail: z.enum(['summary', 'full']).default('summary'),
  }),
  async handler(args, ctx) {
    const rows = await ctx.tx<Array<Record<string, unknown>>>`
      SELECT * FROM harness_shared.goals WHERE id = ${args.id} LIMIT 1
    `;
    if (!rows.length) {
      return { data: null, degraded: true, degradedReasons: [`goal ${args.id} not found`] };
    }
    const goal = rows[0];
    if (args.detail === 'summary') {
      return { data: { id: goal.id, title: goal.title } };
    }
    const children = await ctx.tx<Array<Record<string, unknown>>>`
      SELECT id, title FROM harness_shared.goals WHERE parent_id = ${args.id}
    `;
    return { data: { ...goal, children } };
  },
});
