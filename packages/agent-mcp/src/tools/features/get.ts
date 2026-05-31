/**
 * Get a single feature by (harness slug, feature id).
 *
 * Returns the full row from `harness_shared.harness_features_consolidated`.
 * For agent use when prompt-injected feature history was capped or when
 * inspecting a non-current feature (cross-feature exploration).
 *
 * Typed via `schemaOf(harness_features_consolidated).select`.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { generated, schemaOf } from '@papercusp/db-org';
import { defineTool } from '@papercusp/tooldef';

const features = generated.harnessFeaturesConsolidatedInHarnessShared;
const FeatureSelect = schemaOf(features).select;
type FeatureRow = z.infer<typeof FeatureSelect>;

const SLUG_RE = /^[a-z0-9._-]+$/i;

export default defineTool({
  name: 'features:get',
  profile: 'engineer',
  capability: 'features:read',
  guidance: {
    when: 'User names a specific feature ("the auth one", "F-AUTH-001") and you need its body / acceptance criteria.',
    notWhen: 'For a list of features in a harness, use `harness:list_features`. For changes over time, use `features:history`.',
    chaining: 'Follow `harness:list_features` or `features:search` to find the id.',
  },
  args: z.object({
    slug: z.string().min(1),
    feature_id: z.string().min(1),
  }),
  async handler(args, ctx) {
    if (!SLUG_RE.test(args.slug)) {
      return { data: null, degraded: true, degradedReasons: [`invalid slug ${JSON.stringify(args.slug)}`] };
    }
    const txDb = drizzle(ctx.tx);
    const rows = (await txDb
      .select()
      .from(features)
      .where(and(eq(features.harnessSlug, args.slug), eq(features.featureId, args.feature_id)))
      .limit(1)) as FeatureRow[];
    if (!rows.length) {
      return {
        data: null,
        degraded: true,
        degradedReasons: [`feature ${args.feature_id} not found in harness ${args.slug}`],
      };
    }
    return { data: rows[0] };
  },
});
