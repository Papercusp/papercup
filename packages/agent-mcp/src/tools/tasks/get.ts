/**
 * Get a single task by (harnessSlug, id). Summary returns id+title+status;
 * full returns the row.
 */

import { z } from 'zod';
import { defineTool } from '../../define-tool';

export default defineTool({
  capability: 'tasks:read',
  args: z.object({
    harnessSlug: z.string().min(1),
    id: z.string().min(1),
    detail: z.enum(['summary', 'full']).default('summary'),
  }),
  async handler(args, ctx) {
    const rows = await ctx.tx<Array<Record<string, unknown>>>`
      SELECT *
        FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${args.harnessSlug} AND feature_id = ${args.id}
       LIMIT 1
    `;
    if (!rows.length) {
      return {
        data: null,
        degraded: true,
        degradedReasons: [`task ${args.harnessSlug}/${args.id} not found`],
      };
    }
    if (args.detail === 'summary') {
      const r = rows[0];
      return {
        data: { harnessSlug: r.harness_slug, id: r.feature_id, title: r.title, status: r.status },
      };
    }
    return { data: rows[0] };
  },
});
