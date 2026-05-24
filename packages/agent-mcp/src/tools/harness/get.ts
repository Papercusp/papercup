/**
 * Get a single harness by slug.
 *
 * Summary returns slug + status + name + last activity. Full returns
 * the entire `harness_shared.projects` row plus aggregate feature counts.
 *
 * Typed via `schemaOf(projects).select`.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { generated, schemaOf } from '@restart/db-org';
import { defineTool } from '../../define-tool';

const projects = generated.projectsInHarnessShared;
const features = generated.harnessFeaturesConsolidatedInHarnessShared;
const ProjectSelect = schemaOf(projects).select;
type ProjectRow = z.infer<typeof ProjectSelect>;

export default defineTool({
  name: 'harness:get',
  profile: 'engineer',
  capability: 'harness:read',
  guidance: {
    when: 'User asks about a specific harness by name ("tell me about sheets", "what\'s the status of forms") and you need its row + feature counts.',
    notWhen: 'For a list of all harnesses, use `harness:list`. For LIVE health (escalated/blocked), prefer `harness:status` or `escalations:get` — `harness:get` is the static record.',
    chaining: 'Follow `harness:list` if you don\'t have the slug. Follow with `harness:status` if you also need live counts.',
  },
  args: z.object({
    slug: z.string().min(1),
    detail: z.enum(['summary', 'full']).default('summary'),
  }),
  async handler(args, ctx) {
    const txDb = drizzle(ctx.tx);
    const rows = (await txDb
      .select()
      .from(projects)
      .where(eq(projects.slug, args.slug))
      .limit(1)) as ProjectRow[];
    if (!rows.length) {
      return { data: null, degraded: true, degradedReasons: [`harness ${args.slug} not found`] };
    }
    const row = rows[0];
    if (args.detail === 'summary') {
      return {
        data: {
          slug: row.slug,
          name: row.name,
          status: row.status,
          updated_ts: row.updatedTs,
        },
      };
    }
    const counts = await txDb
      .select({ status: features.status, n: count() })
      .from(features)
      .where(eq(features.harnessSlug, args.slug))
      .groupBy(features.status);
    const featureCounts: Record<string, number> = {};
    for (const c of counts) {
      if (c.status != null) featureCounts[c.status] = Number(c.n);
    }
    return { data: { ...row, featureCounts } };
  },
});
