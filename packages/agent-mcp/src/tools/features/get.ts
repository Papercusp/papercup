/**
 * Get a single feature by (harness slug, feature id).
 *
 * Returns the full row from `harness_shared.harness_features_consolidated`.
 * For agent use when prompt-injected feature history was capped or when
 * inspecting a non-current feature (cross-feature exploration).
 */

import { z } from 'zod';
import { defineTool } from '../../define-tool';

const SLUG_RE = /^[a-z0-9._-]+$/i;

export default defineTool({
  name: 'features:get',
  capability: 'features:read',
  args: z.object({
    slug: z.string().min(1),
    feature_id: z.string().min(1),
  }),
  async handler(args, ctx) {
    if (!SLUG_RE.test(args.slug)) {
      return { data: null, degraded: true, degradedReasons: [`invalid slug ${JSON.stringify(args.slug)}`] };
    }
    const rows = await ctx.tx<Array<Record<string, unknown>>>`
      SELECT harness_slug, feature_id, title, summary, status, attempts, claims,
             notes, metadata, kind, project_id, expected_cost_cents, tags,
             needs_human_review, ts, created_ts, updated_ts,
             parent_id, goal_id, taken_by, taken_at, expires_at, deprecation_reason
        FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${args.slug} AND feature_id = ${args.feature_id}
       LIMIT 1
    `;
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
