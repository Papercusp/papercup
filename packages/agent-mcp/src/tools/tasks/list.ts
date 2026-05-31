/**
 * List tasks across the workspace, optionally filtered by status, goal,
 * or harness. Summary returns id + title + status; full returns the row.
 *
 * Typed via `schemaOf(harness_features_consolidated).select` — response
 * row shape matches the column definition; no hand-typed Record.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { generated, schemaOf } from '@papercusp/db-org';
import { defineTool } from '@papercusp/tooldef';

const features = generated.harnessFeaturesConsolidatedInHarnessShared;
const FeatureSelect = schemaOf(features).select;
type FeatureRow = z.infer<typeof FeatureSelect>;

export default defineTool({
  name: 'tasks:list',
  capability: 'tasks:read',
  guidance: {
    when: 'User asks "what tasks do I have?", "what\'s on my plate", or you need a task id before calling `tasks:get`/`tasks:update`/`tasks:close`.',
    notWhen: 'For ONE task by id, use `tasks:get`. For creating a task, use `tasks:create`. For PROJECTS / FEATURES (work the harness is doing), use `harness:*` — tasks are separate from harness features.',
    chaining: 'Pair with `tasks:get` for detail on a specific row.',
  },
  args: z.object({
    detail: z.enum(['summary', 'full']).default('summary'),
    status: z.string().optional(),
    goalId: z.string().optional(),
    harnessSlug: z.string().optional(),
    limit: z.number().int().positive().max(200).default(50),
    cursor: z.string().optional(),
  }),
  async handler(args, ctx) {
    const txDb = drizzle(ctx.tx);
    const preds = [
      args.harnessSlug ? eq(features.harnessSlug, args.harnessSlug) : undefined,
      args.status ? eq(features.status, args.status) : undefined,
      args.goalId ? eq(features.goalId, args.goalId) : undefined,
    ].filter((p): p is NonNullable<typeof p> => p !== undefined);

    const rows = (await txDb
      .select({
        harness_slug: features.harnessSlug,
        feature_id: features.featureId,
        title: features.title,
        summary: features.summary,
        status: features.status,
        updated_ts: features.updatedTs,
        attempts: features.attempts,
        kind: features.kind,
        project_id: features.projectId,
        expected_cost_cents: features.expectedCostCents,
        goal_id: features.goalId,
      })
      .from(features)
      .where(preds.length ? and(...preds) : undefined)
      .orderBy(desc(features.updatedTs))
      .limit(args.limit)) as Array<
      Pick<
        FeatureRow,
        | 'harness_slug'
        | 'feature_id'
        | 'title'
        | 'summary'
        | 'status'
        | 'updated_ts'
        | 'attempts'
        | 'kind'
        | 'project_id'
        | 'expected_cost_cents'
        | 'goal_id'
      >
    >;

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
