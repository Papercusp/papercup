/**
 * Get a single task by (harnessSlug, id). Summary returns id+title+status;
 * full returns the row.
 *
 * Typed via `schemaOf(harness_features_consolidated).select`.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { generated, schemaOf } from '@restart/db-org';
import { defineTool } from '../../define-tool';

const features = generated.harness_features_consolidatedInHarness_shared;
const FeatureSelect = schemaOf(features).select;
type FeatureRow = z.infer<typeof FeatureSelect>;

export default defineTool({
  name: 'tasks:get',
  capability: 'tasks:read',
  args: z.object({
    harnessSlug: z.string().min(1),
    id: z.string().min(1),
    detail: z.enum(['summary', 'full']).default('summary'),
  }),
  async handler(args, ctx) {
    const txDb = drizzle(ctx.tx);
    const rows = (await txDb
      .select()
      .from(features)
      .where(and(eq(features.harness_slug, args.harnessSlug), eq(features.feature_id, args.id)))
      .limit(1)) as FeatureRow[];
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
