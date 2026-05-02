/**
 * List harnesses registered in the current workspace.
 *
 * Returns slug, status, and last-activity timestamp for each. Use to
 * answer "what harnesses do I have?" or to find a slug before calling
 * harness:get / harness:status.
 */

import { z } from 'zod';
import { defineTool } from '../../define-tool';

export default defineTool({
  capability: 'harness:read',
  args: z.object({
    detail: z.enum(['summary', 'full']).default('summary'),
    limit: z.number().int().positive().max(200).default(50),
    cursor: z.string().optional(),
  }),
  async handler(args, ctx) {
    const rows = await ctx.tx<
      Array<{ slug: string; name: string; status: string; updated_ts: number }>
    >`
      SELECT slug, name, status, updated_ts
        FROM harness_shared.projects
       ORDER BY updated_ts DESC
       LIMIT ${args.limit}
    `;
    if (args.detail === 'summary') {
      return {
        data: rows.map((r) => ({ slug: r.slug, status: r.status })),
      };
    }
    return { data: rows };
  },
});
