/**
 * List tasks across the workspace, optionally filtered by status, goal,
 * or harness. Summary returns id + title + status; full returns the row.
 */

import { z } from 'zod';
import { defineTool } from '../../define-tool';

export default defineTool({
  capability: 'tasks:read',
  args: z.object({
    detail: z.enum(['summary', 'full']).default('summary'),
    status: z.string().optional(),
    goalId: z.string().optional(),
    harnessSlug: z.string().optional(),
    limit: z.number().int().positive().max(200).default(50),
    cursor: z.string().optional(),
  }),
  async handler(args, ctx) {
    // Tasks live in per-harness schemas (harness_<slug>.tasks). For a
    // workspace-wide list, query the consolidated features table which
    // mirrors them. For a harness-specific query, use the per-harness
    // table directly via the harness_features_consolidated table
    // (filtered by harness_slug).
    const tagFilter = args.harnessSlug ? args.harnessSlug : null;
    const statusFilter = args.status ?? null;

    const rows = await ctx.tx<Array<Record<string, unknown>>>`
      SELECT harness_slug, feature_id, title, summary, status, updated_ts,
             attempts, kind, project_id, expected_cost_cents, goal_id
        FROM harness_shared.harness_features_consolidated
       WHERE (${tagFilter}::text IS NULL OR harness_slug = ${tagFilter})
         AND (${statusFilter}::text IS NULL OR status = ${statusFilter})
         AND (${args.goalId ?? null}::text IS NULL OR goal_id = ${args.goalId ?? null})
       ORDER BY updated_ts DESC
       LIMIT ${args.limit}
    `;
    if (args.detail === 'summary') {
      return {
        data: rows.map((r) => ({
          harnessSlug: r.harness_slug,
          id: r.feature_id,
          title: r.title,
          status: r.status,
        })),
      };
    }
    return { data: rows };
  },
});
